'use strict';

function appendText(draft, original) {
  const separator = draft && !draft.endsWith('\n') ? '\n' : '';
  return draft + separator + original.replace(/\r\n?/g, '\n');
}

function sentPrefixMatches(text, lines, consumed) {
  if (!Number.isSafeInteger(consumed) || !lines[0]) return false;
  let end = 0;
  for (let i = 0; i < lines.length; i++) {
    const newline = text.indexOf('\n', end);
    const stop = newline === -1 ? text.length : newline;
    if (text.slice(end, stop) !== lines[i]) return false;
    if (newline === -1 && i < lines.length - 1) return false;
    end = newline === -1 ? stop : stop + 1;
  }
  return consumed === end;
}

module.exports = function createReviewerDraft(session, raw) {
  let text = '', revision = 0, writer = null, needsReview = false, lastSendId = null;
  // A client can have unseen newer raw items while editing. It may never move
  // its accepted raw-input cursor backwards (caption IDs are not raw IDs).
  const inputOffsets = new Map([[0, 0]]);
  let savedOffset = 0;

  function apply(draft, action) {
    if (!writer || !draft || draft.session !== session || draft.revision !== revision ||
        typeof draft.text !== 'string') {
      return {ok:false, error:'校閲原稿の状態が変わりました。再接続して確認してください。'};
    }
    const offset = inputOffsets.get(draft.inputId);
    if (offset === undefined || offset < savedOffset) return {ok:false, error:'入力原稿の受信位置を確認してください。'};
    let remainder = draft.text.replace(/\r\n?/g, '\n');
    if (action) {
      if (needsReview) return {ok:false, error:'引き継いだ原稿を確認してから送出してください。'};
      if (!sentPrefixMatches(remainder, action.lines, action.consumed)) {
        return {ok:false, error:'送出内容と編集欄の先頭が一致しません。'};
      }
      remainder = remainder.slice(action.consumed);
    }
    for (let i = offset; i < raw.length; i++) remainder = appendText(remainder, raw[i].text);
    text = remainder;
    savedOffset = offset;
    if (action) {
      revision++;
      lastSendId = action.id;
    }
    else if (draft.confirmed === true) needsReview = false;
    return {ok:true, revision};
  }

  return {
    append(item) {
      raw.push(item);
      inputOffsets.set(item.id, raw.length);
      text = appendText(text, item.text);
    },
    join(options) {
      if (options?.draftProtocol !== 1) {
        if (writer) return {ok:false, error:'校閲画面を再読み込みしてから入室してください。'};
        return {ok:true};
      }
      if (typeof options.clientId !== 'string' || !options.clientId || options.clientId.length > 128) {
        return {ok:false, error:'校閲端末の識別子を確認してください。'};
      }
      if (writer !== options.clientId) {
        writer = options.clientId;
        savedOffset = raw.length;
        revision++;
      }
      return {ok:true, reviewDraft:{text, inputId:raw.at(-1)?.id ?? 0, revision, needsReview, lastSendId}};
    },
    save(draft) { return apply(draft); },
    send(request) {
      if (writer) return apply(request.draft, request);
      if (request.draft !== undefined) return {ok:false, error:'校閲画面を再接続してください。'};
      // Older clients never send their consumed draft. A modern client must
      // reconcile previously received input before enabling automatic sends.
      needsReview = true;
      return {ok:true};
    },
  };
};
