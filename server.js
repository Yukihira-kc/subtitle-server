<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<title>字幕コラボ</title>

<script src="https://cdn.socket.io/4.7.2/socket.io.min.js"></script>

</head>

<body style="background:#111;color:white;font-family:sans-serif">

<h1>字幕コラボ</h1>

<div id="role-select">
  <h2>担当を選択</h2>
  <button onclick="selectRole('A')">A</button>
  <button onclick="selectRole('B')">B</button>
  <button onclick="selectRole('C')">C</button>
</div>

<div id="app" style="display:none"></div>

<script>
const socket = io("https://subtitle-server-czoz.onrender.com");

let inputs = { A:"", B:"", C:"" };
let active = "A";
let log = [];
let myRole = null;

// ✅ 並び順
function getOrder() {
  if (myRole === "A") return ["C", "A", "B"];
  if (myRole === "B") return ["A", "B", "C"];
  if (myRole === "C") return ["B", "C", "A"];
  return ["A", "B", "C"];
}

// ✅ UI初期化
function initUI() {
  const app = document.getElementById("app");

  app.innerHTML = `
    <div id="columns"></div>
    <div>
      <h2>ログ</h2>
      <div id="log"></div>
    </div>
  `;

  const col = document.getElementById("columns");

  col.innerHTML = getOrder().map(k => `
    <div>
      <h3 id="label-${k}"></h3>

      <textarea id="input-${k}" style="width:200px;height:100px"></textarea>

      <br>

      <button id="btn-${k}">送信</button>
    </div>
  `).join("");

  ["A","B","C"].forEach(k => {

    document.getElementById("input-" + k).oninput = (e) => {
      typing(k, e.target.value);
    };

    document.getElementById("btn-" + k).onclick = () => {
      send(k);
    };
  });

  updateUI();
}

// ✅ 更新（修正版）
function updateUI() {

  ["A","B","C"].forEach(k => {

    const label = document.getElementById("label-" + k);
    const input = document.getElementById("input-" + k);
    const btn = document.getElementById("btn-" + k);

    label.textContent =
      k +
      (myRole === k ? "（自分）" : "") +
      (active === k ? " ←送信可" : "");

    input.disabled = myRole !== k;

    // ✅ ✅ ここが修正ポイント
    // 👉 自分の欄だけ更新しない
    if (k !== myRole) {
      input.value = inputs[k];
    } else {
      // 自分の欄はカーソル壊さないように一応保険
      if (document.activeElement !== input) {
        input.value = inputs[k];
      }
    }

    btn.disabled = !(active === k && myRole === k);
  });

  document.getElementById("log").innerHTML =
    log.map(l => `<div>[${l.key}] ${l.text}</div>`).join("");
}

// ✅ 役割選択
function selectRole(role) {
  myRole = role;

  document.getElementById("role-select").style.display = "none";
  document.getElementById("app").style.display = "block";

  initUI();
}

// ✅ 入力
function typing(key, value) {
  inputs[key] = value;
  socket.emit("typing", { key, value });
}

// ✅ 🔥 他人入力を確実反映
socket.on("typing", ({ key, value }) => {
  inputs[key] = value;

  // ✅ 必ず反映
  updateUI();
});

// ✅ 送信
function send(key) {

  if (active !== key) return;

  socket.emit("send", {
    key,
    text: inputs[key]
  });

  socket.emit("typing", {
    key,
    value: ""
  });

  inputs[key] = "";

  updateUI();
}

// ✅ ログ
socket.on("log", (data) => {
  log.unshift(data);
  updateUI();
});

// ✅ 送信権
socket.on("active", (next) => {
  active = next;
  updateUI();
});

</script>

</body>
</html>
``
