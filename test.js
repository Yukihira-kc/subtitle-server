const { spawn } = require('child_process');
const { io } = require('socket.io-client');

const port = 3102;
const url = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['server.js'], {
  cwd: __dirname,
  env: { ...process.env, PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe']
});

function fail(error) {
  console.error(error instanceof Error ? error.stack : error);
  server.kill();
  process.exitCode = 1;
}
function waitForServer() {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('テストサーバーを起動できませんでした。')), 5000);
    server.stdout.on('data', data => {
      if (String(data).includes('subtitle server')) {
        clearTimeout(timer);
        resolve();
      }
    });
    server.on('error', reject);
    server.stderr.on('data', data => console.error(String(data)));
  });
}
function once(socket, event) {
  return new Promise(resolve => socket.once(event, resolve));
}
function acknowledge(socket, event, data) {
  return new Promise(resolve => socket.emit(event, data, resolve));
}

(async () => {
  await waitForServer();
  const reviewer = io(url, { transports: ['websocket'] });
  const operator = io(url, { transports: ['websocket'] });
  await Promise.all([once(reviewer, 'connect'), once(operator, 'connect')]);

  const joined = await acknowledge(reviewer, 'joinReviewer', {});
  if (!joined.ok || joined.settings.columns !== 15 || joined.throughMode !== false) {
    throw new Error('校閲接続時の初期状態が不正です。');
  }

  const changedSettings = once(reviewer, 'settings');
  const setting = await acknowledge(reviewer, 'setSettings', {
    columns: 15,
    captionFont: 'noto-serif-jp',
    textColor: '#ff0000',
    outline: false,
    fontWeight: 'bold'
  });
  if (!setting.ok) throw new Error('文字数・フォント設定を保存できませんでした。');
  const currentSettings = await changedSettings;
  if (currentSettings.columns !== 15 || currentSettings.captionFont !== 'noto-serif-jp' || currentSettings.textColor !== '#ff0000' || currentSettings.outline !== false || currentSettings.fontWeight !== 'bold') {
    throw new Error('字幕の表示設定が共有されませんでした。');
  }

  const on = await acknowledge(reviewer, 'setThroughMode', { enabled: true });
  if (!on.ok || on.enabled !== true) throw new Error('スルーモードをONにできませんでした。');

  operator.emit('register', { key: 'A' });
  await once(operator, 'active');
  const reviewThrough = once(reviewer, 'reviewItem');
  operator.emit('send', { key: 'A', text: 'スルーモード確認' });
  const throughItem = await reviewThrough;
  if (throughItem.text !== 'スルーモード確認') throw new Error('スルー中の原稿が校閲へ届きません。');
  const before = await acknowledge(reviewer, 'joinReviewer', {});
  if (before.waiting.length || before.display.lines.length) throw new Error('校閲を経由せず字幕が送出されました。');
  const request = { id: 'through-test-1', kind: 'send', lines: [throughItem.text] };
  const sent = await acknowledge(reviewer, 'captionAction', request);
  const duplicate = await acknowledge(reviewer, 'captionAction', request);
  if (!sent.ok || duplicate.id !== sent.id) throw new Error('受付確認または重複防止が不正です。');
  const after = await acknowledge(reviewer, 'joinReviewer', {});
  if (after.waiting.length || after.display.lines.join('') !== throughItem.text) throw new Error('校閲経由の送出が不正です。');

  const off = await acknowledge(reviewer, 'setThroughMode', { enabled: false });
  if (!off.ok || off.enabled !== false) throw new Error('スルーモードをOFFにできませんでした。');
  const reviewItem = once(reviewer, 'reviewItem');
  operator.emit('send', { key: 'A', text: '通常モード確認' });
  const received = await reviewItem;
  if (received.text !== '通常モード確認') throw new Error('通常モードの校閲受信が不正です。');

  reviewer.close();
  operator.close();
  server.kill();
  console.log('v29 legacy practice regression passed');
})().catch(fail);
