// Windowsのコマンドプロンプトから npm run test:server で起動するローカル試験サーバー。
process.env.LOCAL_TEST_FRONTEND='1';
process.env.PORT=process.env.PORT||'3001';
require('./server.js');
