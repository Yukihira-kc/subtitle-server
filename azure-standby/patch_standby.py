#!/usr/bin/env python3
"""Patch the reviewer release into a private Kudu wwwroot ZIP without extracting it."""

import argparse
from datetime import datetime, timedelta, timezone
from difflib import SequenceMatcher
from hashlib import sha256
import json
import os
from pathlib import Path, PurePosixPath
from shutil import copyfileobj
import stat
import sys
from tempfile import NamedTemporaryFile
from unicodedata import normalize
from zipfile import BadZipFile, ZIP_DEFLATED, ZIP_STORED, ZipFile, ZipInfo

MIB = 1024 * 1024
MAX_ARCHIVE = 250 * MIB
MAX_CODE_FILE = 2 * MIB
SOURCE_HASHES = {
    # subtitle-server 69ba1c7fc2fb11981cc23e30eaffee25e6e2fdab, server.js
    'server.base.js': '847b938dba6b060772e5b6a294df4ef2dfb282f0e3208028f205918c42bf8b17',
    # subtitle-server f83bf99c9048730f909c3bf89462821d0b1e252c, server.js and reviewer-draft.js
    'server.release.js': '974d3b750d632df91fa30334a7ddb7a0c2ca0909ca616206d75356ac81703a52',
    'reviewer-draft.js': 'ed4ce9de37fbd26ba705845c18573c58290dbff035e3c384ecca7371b60d69e3',
    # subtitle-ui 66eaad2e0449f09151c82f05734c724d18dcce97, reviewer.js
    'reviewer.js': '10ece6649d9a687def6afe9893e1c01621e09f6fb3809b8099cefffedbd7acd5',
}
OLD_REVIEWER_JS = '39e8523cbc04e8d8be44a5a7ddd298f65f218e483c41c571fb7b93d911768e9d'
OLD_AZURE_REVIEWER_HTML = '1e5f064e96d4798f6f63288d683031983a675b86e8676bd5ad0e97cc6a543ea4'
NEW_AZURE_REVIEWER_HTML = 'f94d043b8e61fca1683b447c51a8bb7bf683ea4b0709169d0369867f49d5e3d2'
OLD_LINK = b'reviewer.js?v=29.8-queue-scroll'
NEW_LINK = b'reviewer.js?v=29.8-handoff'


class ValidationError(Exception):
    """A failed precondition with a safe-to-print explanation."""


def digest(data):
    return sha256(data).hexdigest()


def sources(directory):
    result = {}
    for name, expected_hash in SOURCE_HASHES.items():
        path = directory / name
        if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_CODE_FILE:
            raise ValidationError('A reviewed release input is missing or unsafe.')
        data = path.read_bytes()
        if digest(data) != expected_hash:
            raise ValidationError('A reviewed release input has an unexpected SHA-256.')
        result[name] = data
    return result


def archive_members(archive, overlay):
    entries = archive.infolist()
    if not entries or len(entries) > 50000 or sum(i.file_size for i in entries) > MAX_ARCHIVE:
        raise ValidationError('The source archive has an unexpected size or entry count.')
    members = {}
    paths = {}
    for item in entries:
        name = item.filename.rstrip('/')
        parts = name.split('/')
        if (item.orig_filename != item.filename or not name
                or (item.is_dir() and item.filename != name + '/')
                or any(part in {'', '.', '..'} for part in parts)
                or any(c in name for c in '\\:')
                or any(ord(c) < 32 or ord(c) == 127 for c in name)):
            raise ValidationError('The source archive contains an unsafe path.')
        mode = item.external_attr >> 16
        file_type = stat.S_IFMT(mode)
        if (file_type not in {0, stat.S_IFDIR if item.is_dir() else stat.S_IFREG}
                or mode & 0o7000
                or (item.is_dir() and item.file_size)
                or item.flag_bits & 1
                or item.compress_type not in {ZIP_STORED, ZIP_DEFLATED}):
            raise ValidationError('The source archive contains a link or unsupported entry.')
        if name in members:
            raise ValidationError('The source archive contains a duplicate entry.')
        for depth in range(1, len(parts) + 1):
            path = '/'.join(parts[:depth])
            key = normalize('NFC', path).casefold()
            kind = 'directory' if depth < len(parts) or item.is_dir() else 'file'
            if paths.setdefault(key, (path, kind)) != (path, kind):
                raise ValidationError('The source archive contains conflicting paths.')
        if not overlay and any(
            part.casefold() in {'.data', '.git', '.npmrc', 'rooms.json', 'publishsettings'}
            or part.casefold().startswith('.env')
            or part.casefold().endswith('.publishsettings')
            for part in parts
        ):
            raise ValidationError('The source archive contains runtime data or private configuration. Use a verified overlay workflow.')
        members[name] = item
    return members


def read_code(archive, entry):
    if entry.is_dir() or entry.file_size > MAX_CODE_FILE:
        raise ValidationError('An expected source file is not a regular code file.')
    return archive.read(entry)


def in_directory(directory, basename):
    return str(directory / basename)


def patch_backend(data, base, release):
    newline = b'\r\n' if b'\r\n' in data else b'\n'
    if newline == b'\r\n':
        if b'\n' in data.replace(newline, b''):
            raise ValidationError('The backend uses mixed line endings.')
        data = data.replace(newline, b'\n')
    old_lines, new_lines = base.splitlines(keepends=True), release.splitlines(keepends=True)
    diff = SequenceMatcher(None, old_lines, new_lines, autojunk=False)
    end = 0
    for group in diff.get_grouped_opcodes(1):
        old = b''.join(old_lines[group[0][1]:group[-1][2]])
        new = b''.join(new_lines[group[0][3]:group[-1][4]])
        old_count, new_count = data.count(old), data.count(new)
        if old_count == 1 and new_count == 0:
            offset = data.index(old)
            if offset < end:
                raise ValidationError('Backend patch anchors appear out of order.')
            data = data[:offset] + new + data[offset + len(old):]
        elif new_count == 1 and old_count == 0:
            offset = data.index(new)
            if offset < end:
                raise ValidationError('Backend release anchors appear out of order.')
        else:
            raise ValidationError('A backend reviewer patch anchor did not match uniquely.')
        end = offset + len(new)
    return data.replace(b'\n', newline) if newline != b'\n' else data


def changes_for(archive, members, release):
    backend = []
    for name, entry in members.items():
        path = PurePosixPath(name)
        if entry.is_dir() or path.name != 'server.js' or 'node_modules' in path.parts:
            continue
        if not all(in_directory(path.parent, sibling) in members
                   and not members[in_directory(path.parent, sibling)].is_dir()
                   for sibling in ('package.json', 'rooms.js', 'pagination.js')):
            continue
        data = read_code(archive, entry)
        try:
            revised = patch_backend(data, release['server.base.js'], release['server.release.js'])
        except ValidationError:
            continue
        backend.append((path, data, revised))
    if len(backend) != 1:
        raise ValidationError('Expected exactly one matching standby backend.')
    server, server_old, server_new = backend[0]

    frontend = []
    for name, entry in members.items():
        html = PurePosixPath(name)
        if (entry.is_dir() or html.name != 'reviewer.html' or 'node_modules' in html.parts
                or not html.is_relative_to(server.parent)):
            continue
        js_name = in_directory(html.parent, 'reviewer.js')
        if not all(in_directory(html.parent, sibling) in members
                   and not members[in_directory(html.parent, sibling)].is_dir()
                   for sibling in ('reviewer.js', 'connection.js', 'rooms.html')):
            continue
        html_data = read_code(archive, entry)
        js_data = read_code(archive, members[js_name])
        if (digest(html_data) in {OLD_AZURE_REVIEWER_HTML, NEW_AZURE_REVIEWER_HTML}
                and digest(js_data) in {OLD_REVIEWER_JS, SOURCE_HASHES['reviewer.js']}):
            frontend.append((name, html_data, js_name, js_data))
    if len(frontend) != 1:
        raise ValidationError('Expected exactly one matching standby reviewer frontend.')
    html_name, html_old, js_name, js_old = frontend[0]
    html_new = html_old.replace(OLD_LINK, NEW_LINK, 1)
    if digest(html_new) != NEW_AZURE_REVIEWER_HTML:
        raise ValidationError('The updated standby reviewer HTML has an unexpected SHA-256.')

    draft_name = in_directory(server.parent, 'reviewer-draft.js')
    draft = release['reviewer-draft.js']
    observed = {str(server):server_old, html_name:html_old, js_name:js_old}
    if draft_name in members:
        observed[draft_name] = read_code(archive, members[draft_name])
        if observed[draft_name] != draft:
            raise ValidationError('A different reviewer-draft.js is already deployed.')
    desired = {draft_name:draft, str(server):server_new, js_name:release['reviewer.js'], html_name:html_new}
    return {name:data for name, data in desired.items() if observed.get(name) != data}


def output_metadata(name, original, changed=False):
    result = ZipInfo(name + ('/' if original and original.is_dir() else ''))
    result.compress_type = ZIP_DEFLATED
    if original:
        result.date_time = original.date_time
        result.create_system = original.create_system
        result.external_attr = original.external_attr
    else:
        result.create_system = 3
        result.external_attr = 0o100644 << 16
    if changed:
        stamp = datetime.now(timezone.utc).replace(microsecond=0)
        stamp -= timedelta(seconds=stamp.second % 2)
        if result.date_time == stamp.timetuple()[:6]:
            stamp += timedelta(seconds=2)
        result.date_time = stamp.timetuple()[:6]
    return result


def write_zip(archive, members, changes, output, overlay):
    with NamedTemporaryFile(dir=output.parent, delete=False) as temp:
        temporary = Path(temp.name)
    try:
        with ZipFile(temporary, 'w', compression=ZIP_DEFLATED) as final:
            if not overlay:
                for name, original in members.items():
                    if name in changes:
                        continue
                    entry = output_metadata(name, original)
                    if original.is_dir():
                        final.writestr(entry, b'')
                    else:
                        with archive.open(original) as source, final.open(entry, 'w') as target:
                            copyfileobj(source, target, 256 * 1024)
            for name, data in changes.items():
                final.writestr(output_metadata(name, members.get(name), changed=True), data)
        with ZipFile(temporary) as final:
            if final.testzip() is not None:
                raise ValidationError('The output package failed its archive validation.')
        os.link(temporary, output)
    finally:
        temporary.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input_zip', type=Path)
    parser.add_argument('output_zip', type=Path)
    parser.add_argument('--sources', type=Path, default=Path(__file__).resolve().parent / 'release-inputs')
    parser.add_argument('--overlay', action='store_true', help='Output changed files for Kudu ZIP PUT only.')
    parser.add_argument('--inspect', action='store_true', help='Validate and report without writing a ZIP.')
    args = parser.parse_args()
    try:
        if (args.input_zip.is_symlink() or not args.input_zip.is_file()
                or args.input_zip.stat().st_size > MAX_ARCHIVE):
            raise ValidationError('The source ZIP is missing or unsafe.')
        if args.output_zip.exists() or args.output_zip.is_symlink():
            raise ValidationError('The destination ZIP already exists.')
        release = sources(args.sources)
        with ZipFile(args.input_zip) as archive:
            members = archive_members(archive, args.overlay)
            changes = changes_for(archive, members, release)
            if changes and not args.inspect:
                write_zip(archive, members, changes, args.output_zip, args.overlay)
        print(json.dumps({
            'status': 'ready' if changes else 'unchanged',
            'format': 'overlay' if args.overlay else 'full',
            'changed': list(changes),
            'wrote_zip': bool(changes) and not args.inspect,
        }))
    except ValidationError as error:
        print(json.dumps({'status':'error', 'message':str(error)}), file=sys.stderr)
        return 1
    except (OSError, BadZipFile, RuntimeError, ValueError, NotImplementedError):
        print(json.dumps({'status':'error', 'message':'A source file or ZIP could not be processed safely.'}), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
