// Save-conflict playground (plan C/D).
// 2つの保存要求の応答順を外部から制御し、遅い古い応答が
// 新しい内容を巻き戻すかを観測する。
//
// パスに "fixed" を含む場合は rev 比較で古い応答を破棄する修正版、
// それ以外は受け取った応答をそのまま適用する naive 版。
//
// 観測用マーカー:
//   pending-tags … 未応答の保存タグ（"none"|"a"|"b"|"a,b"）
//   sent-tags    … 最後に送信した保存タグ（"none"|"a"|"b"）
//   view-tags    … エディタ表示内容のタグ（"empty"|"a"|"b"|"x"）。
//                  入力イベントと応答適用の両方で更新する。
//                  具体値ではなくタグを出すため抽象観測と独立に読める。

const ta = document.getElementById("doc-body");
const saveBtn = document.getElementById("save-button");
const pendingEl = document.getElementById("pending-tags");
const sentEl = document.getElementById("sent-tags");
const viewEl = document.getElementById("view-tags");
const FIXED = location.pathname.includes("fixed");

let docKey = sessionStorage.getItem("tidal-doc-key");
if (!docKey) {
  docKey = crypto.randomUUID();
  sessionStorage.setItem("tidal-doc-key", docKey);
}

const pending = new Set();
let sentTag = "none";
let lastRev = 0;

function tagOf(body) {
  // 具象入力は tidal-<seed>-conflict-body-{a,b} 形。末尾の inputId で判定する。
  if (body.endsWith("conflict-body-b") || body.includes("BODY-B")) return "b";
  if (body.endsWith("conflict-body-a") || body.includes("BODY-A")) return "a";
  return "x";
}

function viewTag() {
  return ta.value === "" ? "empty" : tagOf(ta.value);
}

function render() {
  pendingEl.textContent = pending.size ? [...pending].sort().join(",") : "none";
  sentEl.textContent = sentTag;
  viewEl.textContent = viewTag();
}

ta.addEventListener("input", render);

async function api(method, payload) {
  const r = await fetch(`/api/docs?key=${encodeURIComponent(docKey)}`, {
    method,
    headers: { "content-type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`api ${method} failed: ${r.status}`);
  return r.json();
}

saveBtn.addEventListener("click", async () => {
  const body = ta.value;
  const tag = tagOf(body);
  sentTag = tag;
  pending.add(tag);
  render();
  try {
    const res = await api("PUT", { body });
    // naive: 最後に届いた応答を無条件で適用（古い応答で巻き戻る）
    // fixed: rev が最新のものだけ適用（古い応答は破棄）
    if (!FIXED || res.rev > lastRev) {
      ta.value = res.body;
      lastRev = res.rev;
    }
  } catch {
    // 通信失敗時は表示を変えない
  } finally {
    pending.delete(tag);
    render();
  }
});

render();
