// Minimal static file server for fixture apps (Phase 4).
// Usage: node fixtures/server.mjs [port]  (default 4173)
// /api/docs?key=K: GET returns {body}, PUT accepts {body} JSON.
// /api/reset: clears the doc store (per-run initialization for previews).
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, normalize, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const port = parseInt(process.argv[2] ?? "4173", 10);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

// 文書ストア: ブラウザーのリセットでは消えないサーバー側状態（plan B/C 用）。
// キーはページ側が発行する試行ごとの ID（sessionStorage）を想定。
const docs = new Map();

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (url.pathname === "/api/docs") {
      const key = url.searchParams.get("key") ?? "";
      if (req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ body: docs.get(key)?.body ?? "" }));
        return;
      }
      if (req.method === "PUT" || req.method === "POST") {
        const raw = await readBody(req);
        let body = "";
        try {
          body = String(JSON.parse(raw).body ?? "");
        } catch {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "invalid json" }));
          return;
        }
        // rev はキーごとの単調増加。応答順が入れ替わる競合で
        // クライアントが古い応答を識別できるようにする（plan C/D）。
        const cur = docs.get(key);
        const rev = (cur?.rev ?? 0) + 1;
        docs.set(key, { body, rev });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, body, rev }));
        return;
      }
      res.writeHead(405).end();
      return;
    }

    if (url.pathname === "/api/reset" && req.method === "POST") {
      docs.clear();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    let path = normalize(url.pathname).replace(/^([/\\])+/, "");
    if (path === "") path = "index.html";
    const file = join(root, path);
    if (!file.startsWith(root)) {
      res.writeHead(403).end();
      return;
    }
    const body = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}).listen(port, () => console.log(`fixtures server: http://localhost:${port}`));
