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
  if (!joined.ok || joined.settings.columns !== 20 || joined.throughMode !== false) {
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
  const queueChanged = once(reviewer, 'captionQueue');
  operator.emit('send', { key: 'A', text: 'スルーモード確認' });
  const waiting = await queueChanged;
  if (!waiting.length || waiting[0].lines.join('') !== 'スルーモード確認' || waiting[0].columns !== 15) {
    throw new Error('スルーモードの送信待機追加が不正です。');
  }

  const off = await acknowledge(reviewer, 'setThroughMode', { enabled: false });
  if (!off.ok || off.enabled !== false) throw new Error('スルーモードをOFFにできませんでした。');
  const reviewItem = once(reviewer, 'reviewItem');
  operator.emit('send', { key: 'A', text: '通常モード確認' });
  const received = await reviewItem;
  if (received.text !== '通常モード確認') throw new Error('通常モードの校閲受信が不正です。');

  reviewer.close();
  operator.close();
  server.kill();
  console.log('v27 integration test passed');
})().catch(fail);
