import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

import { verifyFrameworkFixtures } from "../src/acceptance.ts";
import { loadBindingJson } from "../src/binding.ts";
import type { FrameworkFixture, GoldenExpectation, UxSpec } from "../src/ir.ts";

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
const playgroundSpecJson = JSON.parse(
  readFileSync(join(root, "examples/doc-playground.spec.json"), "utf8"),
) as UxSpec;
const conflictSpecJson = JSON.parse(
  readFileSync(join(root, "examples/save-conflict.spec.json"), "utf8"),
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

// plan B: 文書 playground（バニラ JS + /api/docs）。正常版は PASS、
// 保存を偽装する版は独立オラクルが具体値の消失を CONFIRMED する。
// framework フィールドは診断接頭辞にしか使われないためラベルとして流用する。
const playgroundCases: [string, string, GoldenExpectation][] = [
  [
    "playground ok",
    "playground.ok.binding.json",
    { overall: "PASS", exitCode: 0, requiredEvidenceFields: [] },
  ],
  [
    "playground lossy",
    "playground.lossy.binding.json",
    {
      overall: "CONFIRMED",
      exitCode: 1,
      target: "implementation",
      evidenceKind: "INDEPENDENT_ORACLE",
      requiredEvidenceFields: ["expectedValue", "actualValue", "events"],
    },
  ],
];
for (const [name, bindingFile, expected] of playgroundCases) {
  test(`acceptance: ${name}`, async () => {
    const binding = loadBindingJson(join(root, `examples/${bindingFile}`));
    const fixture: FrameworkFixture = {
      framework: "react" as never, // vanilla fixture: label only
      binding,
    };
    const diags = await verifyFrameworkFixtures(playgroundSpecJson, fixture, expected);
    assert.deepEqual(diags, []);
  });
}

// plan C/D: 保存応答の順序制御（hold/release）+ 独立オラクル。
// 同一 spec+binding 構成で、naive 版は古い応答による巻き戻りを
// INDEPENDENT_ORACLE で CONFIRMED、fixed 版は oracle/conformance が PASS。
// model target は spec が stale 適用を env 分岐として許容するため両版で
// CONFIRMED（仕様が禁止遷移を含むことの反例 = A→B 送信・B→A 応答順）。
const conflictCases: [string, string, GoldenExpectation][] = [
  [
    "save-conflict naive",
    "save-conflict.naive.binding.json",
    {
      overall: "CONFIRMED",
      exitCode: 1,
      evidenceKind: "INDEPENDENT_ORACLE",
      requiredEvidenceFields: ["events"],
      targetVerdicts: {
        model: "CONFIRMED",
        conformance: "PASS",
        implementation: "CONFIRMED",
      },
    },
  ],
  [
    "save-conflict fixed",
    "save-conflict.fixed.binding.json",
    {
      overall: "CONFIRMED",
      exitCode: 1,
      evidenceKind: "MODEL_COUNTEREXAMPLE",
      requiredEvidenceFields: ["events"],
      targetVerdicts: {
        model: "CONFIRMED",
        conformance: "PASS",
        implementation: "PASS",
      },
    },
  ],
];
for (const [name, bindingFile, expected] of conflictCases) {
  test(`acceptance: ${name}`, async () => {
    const binding = loadBindingJson(join(root, `examples/${bindingFile}`));
    const fixture: FrameworkFixture = {
      framework: "react" as never, // vanilla fixture: label only
      binding,
    };
    const diags = await verifyFrameworkFixtures(conflictSpecJson, fixture, expected);
    assert.deepEqual(diags, []);
  });
}
