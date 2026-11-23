// Shared playground app logic for fixtures/apps/playground{,-lossy}/.
// 文書本文をサーバー (/api/docs) に保存し、リロードで開き直す。
// 文書キーは sessionStorage の試行ごとの ID: ブラウザーコンテキスト
// (トレース/試行) ごとに新規になり、サーバー側データは残る。
// ?variant=lossy またはパスに "lossy" を含む場合、保存は成功を偽装して
// 実際には PUT しない（保存欠落版）。

const ta = document.getElementById("doc-body");
const saveBtn = document.getElementById("save-button");
const statusEl = document.getElementById("doc-status");
const LOSSY =
  new URLSearchParams(location.search).get("variant") === "lossy" ||
  location.pathname.includes("lossy");

let docKey = sessionStorage.getItem("tidal-doc-key");
if (!docKey) {
  docKey = crypto.randomUUID();
  sessionStorage.setItem("tidal-doc-key", docKey);
}

let status = "empty";
let interacted = false;

function render() {
  statusEl.textContent = status;
}

async function api(method, payload) {
  const r = await fetch(`/api/docs?key=${encodeURIComponent(docKey)}`, {
    method,
    headers: { "content-type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`api ${method} failed: ${r.status}`);
  return r.json();
}

async function load() {
  try {
    const { body } = await api("GET");
    // 入力が先に走った場合は取得結果で上書きしない（レース防止）
    if (interacted) return;
    ta.value = body ?? "";
    status = ta.value ? "saved" : "empty";
    render();
  } catch {
    status = "error";
    render();
  }
}

ta.addEventListener("input", () => {
  interacted = true;
  status = "dirty";
  render();
});

saveBtn.addEventListener("click", async () => {
  if (LOSSY) {
    // 保存欠落版: 成功に見せるがサーバーへは書き込まない
    status = "saved";
    render();
    return;
  }
  try {
    await api("PUT", { body: ta.value });
    status = "saved";
  } catch {
    status = "error";
  }
  render();
});

load();
