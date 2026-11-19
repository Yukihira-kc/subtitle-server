#!/usr/bin/env python3
"""Release the manual caption app to the existing Azure standby site."""

import base64
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urljoin, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

HERE = Path(__file__).resolve().parent
APP = "subtitle-standby-jp"
LIVE = f"https://{APP}.azurewebsites.net"
SCM = f"https://{APP}.scm.azurewebsites.net"
AUDIENCE = "api://AzureADTokenExchange"
REVIEWER_SHA = "10ece6649d9a687def6afe9893e1c01621e09f6fb3809b8099cefffedbd7acd5"
REVIEWER_PAGE_SHA = "f94d043b8e61fca1683b447c51a8bb7bf683ea4b0709169d0369867f49d5e3d2"
SOURCES = {
    "server.base.js": ("subtitle-server", "69ba1c7fc2fb11981cc23e30eaffee25e6e2fdab", "server.js"),
    "server.release.js": ("subtitle-server", "f83bf99c9048730f909c3bf89462821d0b1e252c", "server.js"),
    "reviewer-draft.js": ("subtitle-server", "f83bf99c9048730f909c3bf89462821d0b1e252c", "reviewer-draft.js"),
    "reviewer.js": ("subtitle-ui", "66eaad2e0449f09151c82f05734c724d18dcce97", "reviewer.js"),
}
KNOWN_SUBJECTS = {
    "repo:Yukihira-kc/subtitle-server:ref:refs/heads/azure-standby-deploy",
    "repo:Yukihira-kc@287911253/subtitle-server@1249932154:ref:refs/heads/azure-standby-deploy",
}


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


opener = build_opener(NoRedirect())


class RequestFailed(Exception):
    pass


def request(url, operation, *, headers=None, data=None, timeout=30, method=None):
    try:
        return opener.open(Request(url, data=data, headers=headers or {}, method=method), timeout=timeout)
    except HTTPError as error:
        raise RequestFailed(f"{operation}: HTTP {error.code}") from None
    except (TimeoutError, URLError, ConnectionError) as error:
        raise RequestFailed(f"{operation}: {type(error).__name__}") from None


def oidc_assertion():
    endpoint = os.environ["ACTIONS_ID_TOKEN_REQUEST_URL"]
    token_header = {"Authorization": "Bearer " + os.environ["ACTIONS_ID_TOKEN_REQUEST_TOKEN"]}
    separator = "&" if "?" in endpoint else "?"
    with request(endpoint + separator + urlencode({"audience": AUDIENCE}), "GitHub identity", headers=token_header) as reply:
        assertion = json.load(reply)["value"]
    claims = assertion.split(".")[1]
    claims = json.loads(base64.urlsafe_b64decode(claims + "=" * (-len(claims) % 4)))
    if claims.get("sub") not in KNOWN_SUBJECTS:
        raise SystemExit("Unexpected GitHub identity subject")
    print(f"GitHub identity subject: {claims['sub']}", flush=True)
    return assertion


def azure_token(assertion):
    try:
        config = json.loads(os.environ["AZURE_STANDBY_CONFIG"])
        tenant, client, resource = (config[key] for key in ("tenantId", "clientId", "resourceId"))
    except (ValueError, KeyError, TypeError):
        raise SystemExit("AZURE_STANDBY_CONFIG is missing or invalid") from None
    guid = r"[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}"
    if not (re.fullmatch(guid, str(tenant)) and re.fullmatch(guid, str(client)) and
            re.fullmatch(
                r"/subscriptions/" + guid + rf"/resourceGroups/[^/\\?#]+/providers/Microsoft\.Web/sites/{APP}",
                str(resource), re.I,
            )):
        raise SystemExit("Expected Azure authorization for subtitle-standby-jp")
    form = urlencode({
        "client_id": client,
        "scope": "https://management.azure.com/.default",
        "grant_type": "client_credentials",
        "client_assertion_type": "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        "client_assertion": assertion,
    }).encode()
    with request(
        f"https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token", "Azure authorization",
        headers={"Content-Type": "application/x-www-form-urlencoded"}, data=form,
    ) as reply:
        return json.load(reply)["access_token"]


def read_public_release():
    nonce = urlencode({"release-check": time.time_ns()})
    with request(f"{LIVE}/healthz?{nonce}", "Standby health") as reply:
        health = json.load(reply)
    if health.get("edition") != "azure-standby" or health.get("ok") is not True:
        raise SystemExit("Target does not identify as the manual Azure standby")
    with request(f"{LIVE}/reviewer.js?{nonce}", "Reviewer asset") as reply:
        checksum = hashlib.sha256(reply.read()).hexdigest()
    with request(f"{LIVE}/reviewer.html?{nonce}", "Reviewer page") as reply:
        return checksum == REVIEWER_SHA and hashlib.sha256(reply.read()).hexdigest() == REVIEWER_PAGE_SHA


def prepare_sources(directory):
    directory.mkdir()
    for name, (repository, commit, file) in SOURCES.items():
        url = f"https://raw.githubusercontent.com/Yukihira-kc/{repository}/{commit}/{file}"
        with request(url, "Pinned release source") as reply:
            (directory / name).write_bytes(reply.read())


def deploy_package(package, headers):
    url = SCM + "/api/publish?" + urlencode({"type": "zip", "clean": "false", "restart": "true", "async": "true"})
    with package.open("rb") as payload:
        with request(url, "Azure standby publish", headers={
            **headers, "Content-Type": "application/zip", "Content-Length": str(package.stat().st_size),
        }, data=payload, timeout=120, method="POST") as reply:
            location = reply.headers.get("Location")
            print(f"Azure standby publish accepted: HTTP {reply.status}", flush=True)
    if not location:
        return
    status_url = urljoin(SCM, location)
    target = urlsplit(status_url)
    if target.scheme != "https" or target.netloc != urlsplit(SCM).netloc:
        print("Azure returned a status URL outside the configured SCM origin; checking the public release.", flush=True)
        return
    for _ in range(30):
        with request(status_url, "Azure standby deployment status", headers=headers) as reply:
            status = json.load(reply).get("status")
        if status in (4, "4", "Success", "Succeeded"):
            return
        if status in (3, "3", "Failed", "Failure"):
            raise SystemExit("Azure standby deployment failed")
        time.sleep(6)
    raise SystemExit("Azure standby deployment did not complete in time")


def main():
    mode = json.loads((HERE / "operation.json").read_text())["mode"]
    if mode not in ("identity", "inspect", "deploy"):
        raise SystemExit("Unsupported standby operation")
    assertion = oidc_assertion()
    if mode == "identity":
        return
    headers = {"Authorization": "Bearer " + azure_token(assertion)}
    public_ready = read_public_release()
    with tempfile.TemporaryDirectory(prefix="azure-standby-") as temp:
        root = Path(temp)
        original = root / "code.zip"
        revised = root / "release.zip"
        with request(SCM + "/api/zip/site/wwwroot/", "Read standby code package", headers=headers, timeout=90) as reply:
            with original.open("wb") as output:
                shutil.copyfileobj(reply, output)
        prepare_sources(root / "sources")
        subprocess.run(
            ["python3", str(HERE / "patch_standby.py"), str(original), str(revised),
             "--sources", str(root / "sources")], check=True,
        )
        if mode == "inspect":
            if not revised.is_file() and not public_ready:
                raise SystemExit("Standby package is current but the live assets do not match")
            print("Standby package and release patch verified.", flush=True)
            return
        if revised.is_file():
            deploy_package(revised, headers)
        elif not public_ready:
            raise SystemExit("Standby package is current but the live assets do not match")
        for _ in range(20):
            try:
                if read_public_release():
                    print("The manual Azure standby serves the reviewed release.", flush=True)
                    return
            except RequestFailed:
                pass  # The public endpoint can be briefly unavailable during a restart.
            time.sleep(6)
        raise SystemExit("Azure accepted the deployment but the live assets were not updated")


if __name__ == "__main__":
    try:
        main()
    except RequestFailed as error:
        raise SystemExit(str(error)) from None
