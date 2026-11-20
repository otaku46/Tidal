import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

import { verifyFrameworkFixtures } from "../src/acceptance.ts";
import { loadBindingJson } from "../src/binding.ts";
import type { FrameworkFixture, UxSpec } from "../src/ir.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const PORT = 4173;

const specJson = JSON.parse(
  readFileSync(join(root, "examples/draft-retention.spec.json"), "utf8"),
) as UxSpec;
const bindingTemplate = JSON.parse(
  readFileSync(join(root, "examples/draft-retention.binding.json"), "utf8"),
);
const disclosureSpecJson = JSON.parse(
  readFileSync(join(root, "examples/disclosure.spec.json"), "utf8"),
) as UxSpec;

let server: ChildProcess;

before(async () => {
  server = spawn("node", [join(root, "fixtures/server.mjs"), String(PORT)], {
    stdio: "ignore",
  });
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://localhost:${PORT}/fixtures/apps/react/index.html`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("fixture server did not start");
});

after(() => {
  server?.kill();
});

// AC-08: 同一 spec.json + 共通 Playwright アダプターで3フレームワークを検証
for (const fw of ["react", "solid", "svelte"]) {
  test(`acceptance: ${fw} draft-retention`, async () => {
    const binding = JSON.parse(JSON.stringify(bindingTemplate));
    binding.baseUrl = `http://localhost:${PORT}/fixtures/apps/${fw}/index.html`;
    const fixture: FrameworkFixture = { framework: fw as never, binding };
    const diags = await verifyFrameworkFixtures(specJson, fixture, {
      overall: "PASS",
      exitCode: 0,
      requiredEvidenceFields: [],
    });
    assert.deepEqual(diags, []);
  });
}

// disclosure: panel 状態 + note 具体値オラクル（FR-28）を3フレームワークで検証
// binding は examples/disclosure.binding.json を extends で共有し baseUrl のみ差し替える
for (const fw of ["react", "solid", "svelte"]) {
  test(`acceptance: ${fw} disclosure`, async () => {
    const binding = loadBindingJson(
      join(root, `examples/disclosure.${fw}.binding.json`),
    );
    const fixture: FrameworkFixture = { framework: fw as never, binding };
    const diags = await verifyFrameworkFixtures(disclosureSpecJson, fixture, {
      overall: "PASS",
      exitCode: 0,
      requiredEvidenceFields: [],
    });
    assert.deepEqual(diags, []);
  });
}
