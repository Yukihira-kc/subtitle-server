'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const net = require('node:net');
const {mkdtemp, rm} = require('node:fs/promises');
const path = require('node:path');
const {tmpdir} = require('node:os');
const {io} = require('socket.io-client');

test('校閲端末の引継ぎで原稿・待機字幕・表示済みログを混同しない', {timeout:15000}, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'reviewer-handoff-'));
  t.after(() => rm(dir, {recursive:true, force:true}));
  const listener = net.createServer().listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const root = path.join(__dirname, '..');
  const child = spawn(process.execPath, ['server.js'], {
    cwd:root, env:{...process.env, PORT:String(port), ROOM_STORE_PATH:path.join(dir,'rooms.json')},
  });
  t.after(() => child.kill());
  await once(child.stdout, 'data');
  async function connect() {
    const client = io('http://127.0.0.1:' + port, {path:'/socket.io', transports:['websocket'], reconnection:false});
    t.after(() => client.close());
    await once(client, 'connect');
    return client;
  }
  const call = (client, event, data) => client.timeout(2000).emitWithAck(event, data);
  const admission = clientId => ({draftProtocol:1, clientId});
  const operator = await connect();
  const initial = once(operator,'operatorSnapshot');
  await call(operator, 'register', {key:'A', operatorId:'operator'});
  const [{session}] = await initial;
  let inputCount = 0;
  async function original(text) {
    const log = once(operator, 'log');
    operator.emit('send', {key:'A', text, request:'op-'+ ++inputCount, epoch:session}, () => {});
    return (await log)[0].id;
  }
  const reviewer = await connect();
  const first = await call(reviewer, 'joinReviewer', admission('first'));
  const competing = await connect();
  const busy = await call(competing, 'joinReviewer', admission('second'));
  assert.deepEqual(busy, {ok:false, code:'reviewer_busy', error:'校閲者は既に接続中です'});
  const wrongRole = await call(operator, 'joinReviewer', admission('operator'));
  assert.equal(wrongRole.ok, false);
  assert.equal(wrongRole.code, undefined);
  const revision = first.reviewDraft.revision;
  assert.equal(first.reviewDraft.lastSendId, null);
  const a = await original('午前\r\n午後');
  const draft = {session, revision, inputId:a, text:'校正済み午前\n校正済み午後'};
  assert.equal((await call(reviewer,'saveReviewDraft',draft)).ok, true);
  const later = await original('後から届いた原稿');
  const send = {kind:'send', id:'send-one', lines:['校正済み午前'], consumed:'校正済み午前\n'.length, draft};
  assert.equal((await call(reviewer, 'captionAction', {...send, consumed:1})).ok, false);
  assert.equal((await call(operator, 'saveReviewDraft', draft)).ok, false);
  const sent = await call(reviewer, 'captionAction', send);
  assert.deepEqual(await call(reviewer, 'captionAction', send), sent);
  assert.equal(sent.revision, revision+1);
  assert.equal((await call(reviewer, 'saveReviewDraft', draft)).ok, false);
  const interim = await call(reviewer, 'joinReviewer', admission('first'));
  assert.deepEqual(interim.reviewDraft, {
    text:'校正済み午後\n後から届いた原稿', inputId:later, revision:sent.revision, needsReview:false, lastSendId:'send-one',
  });
  reviewer.emit('captionPresented', {id:sent.id, visible:true});
  await call(reviewer, 'captionAction', {kind:'out',id:'clear'});
  await call(reviewer,'setThroughMode',{enabled:true});
  reviewer.disconnect();
  const idle = await original('交代中の原稿');
  const successor = await connect();
  const joined = await call(successor, 'joinReviewer', admission('second'));
  assert.equal(joined.reviewDraft.text, '校正済み午後\n後から届いた原稿\n交代中の原稿');
  assert.equal(joined.reviewDraft.revision, sent.revision+1);
  assert.equal(joined.reviewDraft.inputId, idle);
  assert.equal(joined.throughMode, true);
  assert.deepEqual(joined.display.lines, []);
  assert.deepEqual(joined.history.map(item => item.lines), [['校正済み午前']]);
  assert.equal(joined.raw.length, 3);
  assert.equal((await call(successor, 'saveReviewDraft', {...draft,inputId:idle,revision:sent.revision})).ok, false);
  assert.equal((await call(successor, 'saveReviewDraft', {...draft,inputId:sent.id,revision:joined.reviewDraft.revision})).ok, false);
  const merged = {...joined.reviewDraft, session};
  const lines = ['校正済み午後','後から届いた原稿'];
  const two = await call(successor, 'captionAction', {
    kind:'send',id:'send-two',draft:merged,lines,consumed:lines.join('\n').length+1,
  });
  assert.equal(two.ok, true);
  const final = await call(successor, 'joinReviewer', admission('second'));
  assert.equal(final.reviewDraft.revision, two.revision);
  assert.equal(final.reviewDraft.text,'交代中の原稿');
  assert.equal(final.reviewDraft.lastSendId,'send-two');
  successor.disconnect();
  const old = await connect();
  assert.equal((await call(old, 'joinReviewer', {})).ok, false);
});

test('旧校閲で送出済みの部屋は新校閲で明示確認するまで原稿送出を保留する', () => {
  const createDraft = require('../reviewer-draft');
  const state = createDraft('epoch', []);
  state.append({id:1, text:'旧版で送った原稿'});
  state.join({});
  assert.equal(state.send({lines:['旧版で送った原稿']}).ok, true);
  state.append({id:4, text:'次の原稿'});
  const claim = id => state.join({draftProtocol:1, clientId:id}).reviewDraft;
  const first = claim('new');
  assert.equal(first.needsReview, true);
  assert.equal(state.save({...first, session:'epoch', text:'次の原稿'}).ok, true);
  const second = claim('second');
  assert.equal(second.needsReview, true);
  const confirmed = {...second, session:'epoch', confirmed:true};
  const send = {id:'confirmed', draft:confirmed, consumed:4, lines:['次の原稿']};
  assert.equal(state.send(send).ok, false);
  assert.equal(state.save(confirmed).ok, true);
  assert.equal(state.send(send).ok, true);
  assert.equal(claim('second').text,'');
  state.append({id:7,text:'次の原稿'});
  state.append({id:9,text:''});
  state.append({id:10,text:'新\r行'});
  assert.equal(claim('second').text,'次の原稿\n新\n行');
});

test('同文の原稿を別の受信として保存し、送出済みの範囲だけを除く', () => {
  const draft = require('../reviewer-draft')('epoch', []);
  const join = () => draft.join({draftProtocol:1, clientId:'pc1'}).reviewDraft;
  draft.append({id:1, text:'発言'});
  const first = {...join(), session:'epoch', text:'前半\n校正した後半'};
  draft.append({id:3, text:'発言'});
  draft.append({id:5, text:'発言'});
  const request = {id:'page1', draft:first, lines:['前半'], consumed:3};
  assert.equal(draft.send({...request, lines:['別の原稿']}).ok, false);
  assert.equal(draft.send(request).ok, true);
  assert.equal(draft.send(request).ok, false);
  assert.equal(draft.save(first).ok, false);
  assert.equal(join().text, '校正した後半\n発言\n発言');
});
