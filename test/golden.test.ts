import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { validateSpec } from "../src/spec.ts";
import { exploreModel } from "../src/model.ts";
import { checkProperties } from "../src/properties.ts";
import { aggregateResults, ALL_TARGETS, resolveScope } from "../src/reporting.ts";
import { resolveBinding, type RuntimeConfig } from "../src/binding.ts";
import { runRuntimeChecks, runTrace } from "../src/runtime.ts";
import { makeMockAdapter } from "../src/fixtures.ts";
import { runGoldenCases, type GoldenRunner } from "../src/golden.ts";
import { DraftApp, MockAdapter } from "../src/adapter.ts";
import type { UXAdapter } from "../src/adapter.ts";
import type {
  GoldenCase,
  Report,
  RunResults,
  RunScope,
  RunSelection,
  Target,
  UxSpec,
} from "../src/ir.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const specJson = JSON.parse(
  readFileSync(join(root, "examples/draft-retention.spec.json"), "utf8"),
);
const bindingJson = JSON.parse(
  readFileSync(join(root, "examples/draft-retention.binding.json"), "utf8"),
);

// plan A: goal → hidden → trap。全状態から goal に戻れることを要求する
// canReach 仕様。trap/side2 は行き止まり。
const goalSpecJson = JSON.parse(
  readFileSync(join(root, "examples/return-to-goal.spec.json"), "utf8"),
);
const withLimits = (maxStates: number, maxDepth: number, maxTransitions: number) => {
  const s = JSON.parse(JSON.stringify(goalSpecJson));
  s.analysis = { maxStates, maxDepth, maxTransitions };
  return s;
};

// variant: reload clears the abstract draft (model violation of neverTransition)
const badSpecJson = JSON.parse(JSON.stringify(specJson));
for (const t of badSpecJson.transitions) {
  if (t.id === "t_reload") {
    t.set = { draft: { op: "literal", value: "empty" } };
  }
}

// variant: exploration limit too small → INCONCLUSIVE / EXPLORATION_LIMIT
const limitSpecJson = JSON.parse(JSON.stringify(specJson));
limitSpecJson.analysis = { maxStates: 2, maxDepth: 2, maxTransitions: 3 };

// variant: vacuous property (from is never satisfied) → INCONCLUSIVE / VACUOUS
const vacuousSpecJson = JSON.parse(JSON.stringify(specJson));
vacuousSpecJson.properties.push({
  id: "never_happens",
  kind: "neverTransition",
  from: { op: "literal", value: false },
  to: { op: "literal", value: true },
});

// variant: deadlock — "saved" has no outgoing edges; "reload" never enabled
const deadlockSpecJson = JSON.parse(JSON.stringify(specJson));
for (const t of deadlockSpecJson.transitions) {
  if (t.id === "t_edit") {
    t.when = { op: "eq", args: [
      { op: "ref", variable: "draft" },
      { op: "literal", value: "empty" },
    ]};
  } else if (t.id === "t_save") {
    t.when = { op: "eq", args: [
      { op: "ref", variable: "draft" },
      { op: "literal", value: "dirty" },
    ]};
  } else if (t.id === "t_discard") {
    t.when = { op: "eq", args: [
      { op: "ref", variable: "draft" },
      { op: "literal", value: "dirty" },
    ]};
  } else if (t.id === "t_reload") {
    t.when = { op: "literal", value: false };
  }
}

const CONFIG: RuntimeConfig = {
  allowedOrigins: ["http://localhost:3000"],
  timeoutMs: 5000,
  replayAttempts: 2,
  seed: "golden",
};

async function executeCase(c: GoldenCase): Promise<Report> {
  const { spec, diagnostics } = validateSpec(c.spec);
  const scope: RunScope = c.scope;
  const selection: RunSelection = { requested: scope, declared: [...ALL_TARGETS] };
  const { context, notEvaluated } = resolveScope(selection, [
    "model",
    "conformance",
    "implementation",
  ]);
  const run: RunResults = {
    context,
    results: [],
    coverage: [],
    diagnostics: [...diagnostics],
    notEvaluated: [...notEvaluated],
  };

  if (spec) {
    const effective = new Set(context.effectiveTargets);
    const { graph } = exploreModel(spec);
    if (effective.has("model")) {
      const checked = checkProperties(spec, graph, context);
      run.results.push(...checked.results);
      run.coverage.push(...checked.coverage);
      run.diagnostics.push(...checked.diagnostics);
    }
    if ((effective.has("conformance") || effective.has("implementation")) && c.fixture) {
      const { binding, diagnostics: bd } = resolveBinding(bindingJson, spec, CONFIG);
      run.diagnostics.push(...bd);
      if (binding) {
        const adapter = makeMockAdapter(c.fixture, binding);
        const rt = await runRuntimeChecks(graph, binding, CONFIG, context, adapter);
        run.results.push(...rt.results);
        run.coverage.push(...rt.coverage);
        run.diagnostics.push(...rt.diagnostics);
        run.notEvaluated.push(...rt.notEvaluated);
      }
    }
  }
  return aggregateResults(run);
}

const runner: GoldenRunner = executeCase;

const cases: GoldenCase[] = [
  {
    id: "model-pass",
    spec: specJson,
    scope: { targets: ["model"] },
    expected: {
      overall: "PASS",
      exitCode: 0,
      requiredEvidenceFields: [],
    },
  },
  {
    id: "runtime-retains-pass",
    spec: specJson,
    scope: {},
    fixture: "retains",
    expected: {
      overall: "PASS",
      exitCode: 0,
      requiredEvidenceFields: [],
    },
  },
  {
    id: "runtime-loses-confirmed",
    spec: specJson,
    scope: {},
    fixture: "loses-on-reload",
    expected: {
      overall: "CONFIRMED",
      exitCode: 1,
      target: "implementation",
      evidenceKind: "INDEPENDENT_ORACLE",
      requiredEvidenceFields: ["expectedValue", "actualValue", "events"],
    },
  },
  {
    id: "runtime-locator-error",
    spec: specJson,
    scope: {},
    fixture: "locator-failure",
    expected: {
      overall: "ERROR",
      exitCode: 3,
      cause: "ADAPTER_ERROR",
      requiredEvidenceFields: [],
    },
  },
  {
    id: "runtime-flaky",
    spec: specJson,
    scope: {},
    fixture: "flaky",
    expected: {
      overall: "FLAKY",
      exitCode: 2,
      requiredEvidenceFields: [],
    },
  },
  {
    id: "model-violation-confirmed",
    spec: badSpecJson,
    scope: { targets: ["model"] },
    expected: {
      overall: "CONFIRMED",
      exitCode: 1,
      target: "model",
      evidenceKind: "MODEL_COUNTEREXAMPLE",
      requiredEvidenceFields: ["events", "modelSteps"],
    },
  },
  {
    id: "exploration-limit-inconclusive",
    spec: limitSpecJson,
    scope: { targets: ["model"] },
    expected: {
      overall: "INCONCLUSIVE",
      exitCode: 2,
      cause: "EXPLORATION_LIMIT",
      requiredEvidenceFields: [],
    },
  },
  {
    id: "scope-model-only",
    spec: specJson,
    scope: { targets: ["model" as Target] },
    fixture: "retains",
    expected: {
      overall: "PASS",
      exitCode: 0,
      requiredEvidenceFields: [],
    },
  },
  {
    // AC-04: edit を無視する実装 → 観測がモデル辺と一致しない →
    // conformance は INCONCLUSIVE / MODEL_DIVERGENCE（CONFIRMED にはしない）
    id: "conformance-divergence-inconclusive",
    spec: specJson,
    scope: { targets: ["conformance" as Target] },
    fixture: "ignores-edit",
    expected: {
      overall: "INCONCLUSIVE",
      exitCode: 2,
      cause: "MODEL_DIVERGENCE",
      requiredEvidenceFields: [],
    },
  },
  {
    // FR-09: 充足されない from を持つ性質は VACUOUS → INCONCLUSIVE
    id: "vacuous-property-inconclusive",
    spec: vacuousSpecJson,
    scope: { targets: ["model" as Target] },
    expected: {
      overall: "INCONCLUSIVE",
      exitCode: 2,
      cause: "VACUOUS",
      requiredEvidenceFields: [],
    },
  },
  {
    // edge 単位カバレッジ: saved からの reload でのみ消失する実装を検出する。
    // transition ID 単位のトレース生成では saved 起点の reload が未実行で PASS になる。
    id: "reload-from-saved-divergence",
    spec: specJson,
    scope: { targets: ["conformance" as Target] },
    fixture: "loses-saved-on-reload",
    expected: {
      overall: "INCONCLUSIVE",
      exitCode: 2,
      cause: "MODEL_DIVERGENCE",
      requiredEvidenceFields: [],
    },
  },
  {
    // F3: attempt0 で MISMATCH、再実行で oracle 読み取り ERROR
    // → INCONCLUSIVE / ADAPTER_ERROR（PASS にも CONFIRMED にも落ちない）
    id: "oracle-mismatch-then-error",
    spec: specJson,
    scope: { targets: ["implementation" as Target] },
    fixture: "oracle-error",
    expected: {
      overall: "INCONCLUSIVE",
      exitCode: 2,
      cause: "ADAPTER_ERROR",
      requiredEvidenceFields: [],
    },
  },
  {
    // FLAKY は同一操作列での成否の割れに限定する。
    // saved からの reload でのみ消失する実装: [edit,reload] 経路では MATCH、
    // [edit,save,reload] 経路では安定して MISMATCH。経路間の混在は FLAKY ではなく
    // 安定失敗経路があるため CONFIRMED になる。
    id: "oracle-path-dependent-not-flaky",
    spec: specJson,
    scope: { targets: ["implementation" as Target] },
    fixture: "loses-saved-on-reload",
    expected: {
      overall: "CONFIRMED",
      exitCode: 1,
      target: "implementation",
      evidenceKind: "INDEPENDENT_ORACLE",
      requiredEvidenceFields: ["expectedValue", "actualValue"],
    },
  },
  {
    // AC-10: モデルの確定違反と runtime の ERROR が同居しても
    // 結果は保持され overall は CONFIRMED（確定証拠が優先）
    id: "confirmed-survives-error",
    spec: badSpecJson,
    scope: {},
    fixture: "locator-failure",
    expected: {
      overall: "CONFIRMED",
      exitCode: 1,
      evidenceKind: "MODEL_COUNTEREXAMPLE",
      requiredEvidenceFields: ["events", "modelSteps"],
    },
  },
  {
    // plan A / FR-10: maxStates=1 では goal のみ発見される。
    // 発見済み起点はすべて goal に戻れるが、未探索領域に新たな起点が
    // あり得るため PASS ではなく INCONCLUSIVE / EXPLORATION_LIMIT。
    id: "return-to-goal-maxstates1-inconclusive",
    spec: withLimits(1, 1, 0),
    scope: { targets: ["model"] },
    expected: {
      overall: "INCONCLUSIVE",
      exitCode: 2,
      cause: "EXPLORATION_LIMIT",
      requiredEvidenceFields: [],
    },
  },
  {
    // 深さ上限でも同じ判定になること（上限種別の一貫性）
    id: "return-to-goal-maxdepth0-inconclusive",
    spec: withLimits(10, 0, 100),
    scope: { targets: ["model"] },
    expected: {
      overall: "INCONCLUSIVE",
      exitCode: 2,
      cause: "EXPLORATION_LIMIT",
      requiredEvidenceFields: [],
    },
  },
  {
    // 遷移数上限でも同じ判定になること
    id: "return-to-goal-maxtransitions0-inconclusive",
    spec: withLimits(10, 10, 0),
    scope: { targets: ["model"] },
    expected: {
      overall: "INCONCLUSIVE",
      exitCode: 2,
      cause: "EXPLORATION_LIMIT",
      requiredEvidenceFields: [],
    },
  },
  {
    // 完全探索: trap（と side2）から goal へ戻れない → CONFIRMED。
    // 反例には戻れない起点 trap への操作列 [advance, advance] が残る。
    id: "return-to-goal-confirmed",
    spec: withLimits(10, 10, 100),
    scope: { targets: ["model"] },
    expected: {
      overall: "CONFIRMED",
      exitCode: 1,
      target: "model",
      evidenceKind: "MODEL_COUNTEREXAMPLE",
      requiredEvidenceFields: ["events", "modelSteps"],
    },
  },
  {
    // 部分探索でも反例を確定できる: maxStates=4 では trap の到達範囲が
    // 閉じている（side2 のみ未展開）ため CONFIRMED を維持しつつ、
    // EXPLORATION_LIMIT の cause と診断を両方残す。
    id: "return-to-goal-partial-confirmed",
    spec: withLimits(4, 10, 100),
    scope: { targets: ["model"] },
    expected: {
      overall: "CONFIRMED",
      exitCode: 1,
      target: "model",
      cause: "EXPLORATION_LIMIT",
      evidenceKind: "MODEL_COUNTEREXAMPLE",
      requiredEvidenceFields: ["events", "modelSteps"],
    },
  },
];

test("golden suite: draft-retention cases", async () => {
  const diags = await runGoldenCases(cases, runner);
  assert.deepEqual(diags, []);
});

test("deadlock / unreachable event are reported in errors", async () => {
  const report = await runner({
    id: "deadlock-report",
    spec: deadlockSpecJson,
    scope: { targets: ["model"] },
    expected: { overall: "PASS", exitCode: 0, requiredEvidenceFields: [] },
  });
  const codes = report.errors.map((d) => d.code);
  assert.ok(codes.includes("MODEL_DEADLOCK"), `MODEL_DEADLOCK missing: ${codes}`);
  assert.ok(
    codes.includes("MODEL_UNREACHABLE_EVENT"),
    `MODEL_UNREACHABLE_EVENT missing: ${codes}`,
  );
});

test("coverage counts only executed and observation-matched steps", async () => {
  // 途中で観測が失敗するアプリ: 各トレースは最初の1ステップしか完了しない。
  // 計画上の後続ステップ（save/discard/reload を含む長い経路）が
  // coverage.events / transitions / states に混入しないことを確認する。
  const { spec, diagnostics } = validateSpec(specJson);
  assert.equal(diagnostics.length, 0);
  assert.ok(spec);
  const { binding, diagnostics: bd } = resolveBinding(bindingJson, spec!, CONFIG);
  assert.equal(bd.length, 0);
  assert.ok(binding);
  const { graph } = exploreModel(spec!);
  const { context } = resolveScope(
    { requested: { targets: ["conformance"] }, declared: [...ALL_TARGETS] },
    ["model", "conformance", "implementation"],
  );

  // obs0=read1, step1 後の観測=read2 まで成功、step2 の観測で失敗するアプリ
  class EarlyStopApp extends DraftApp {
    reads = 0;
    override reset() {
      super.reset();
      this.reads = 0;
    }
    override read(read: Parameters<DraftApp["read"]>[0], attempt: number) {
      this.reads++;
      if (this.reads > 2) return undefined;
      return super.read(read, attempt);
    }
  }
  const adapter = new MockAdapter(new EarlyStopApp("early-stop", "never"), binding);
  const rt = await runRuntimeChecks(graph, binding!, CONFIG, context, adapter);
  const conf = rt.coverage.find((c) => c.target === "conformance");
  assert.ok(conf, "conformance coverage missing");
  // 最初のステップは edit か reload（save/discard は dirty 経由でしか到達しない）
  assert.ok(!conf.events.includes("save"), `save must not be covered: ${conf.events}`);
  assert.ok(!conf.events.includes("discard"), `discard must not be covered: ${conf.events}`);
  assert.ok(conf.events.includes("edit"), `edit should be covered: ${conf.events}`);
  // 観測されたのは empty/dirty のみ。saved は未到達
  const draftValues = conf.states.map((s) =>
    s.values.find((v) => v.variable === "draft")?.value,
  );
  assert.ok(!draftValues.includes("saved"), `saved must not be covered: ${draftValues}`);
  // 途中停止した obligation は INCOMPLETE として notEvaluated に残る
  assert.ok(conf.complete === false, "coverage must be incomplete after early stop");
});

test("requiredTransitions: unobserved required branch blocks PASS", async () => {
  // env で a/b に分岐する仕様。t_b を必須遷移に指定。
  // 常に "a" を観測するアプリでは t_b が未観測 → notEvaluated INCOMPLETE →
  // overall は INCONCLUSIVE（PASS にならない）。
  const mkSpec = (required?: string[]) => ({
    schemaVersion: "0.1.0",
    kind: "tidal.uxSpec",
    states: [{ id: "flag", domain: ["a", "b"] }],
    initialState: { values: [{ variable: "flag", value: "a" }] },
    events: [{ id: "flip", kind: "env" }],
    transitions: [
      { id: "t_a", event: "flip", when: { op: "literal", value: true },
        set: { flag: { op: "literal", value: "a" } } },
      { id: "t_b", event: "flip", when: { op: "literal", value: true },
        set: { flag: { op: "literal", value: "b" } } },
    ],
    properties: [],
    analysis: {
      maxStates: 10, maxDepth: 5, maxTransitions: 100,
      ...(required ? { requiredTransitions: required } : {}),
    },
  });
  const binding: Parameters<typeof runTrace>[1] = {
    schemaVersion: "0.1.0",
    baseUrl: "http://localhost:3000",
    events: [{ event: "flip", actions: [] }],
    observe: [],
    oracles: [],
    setup: [],
    reset: [],
    network: [],
    selfTest: [],
  };
  const run = async (observedValue: string, required?: string[]) => {
    const { spec, diagnostics } = validateSpec(mkSpec(required));
    assert.equal(diagnostics.length, 0);
    const { graph } = exploreModel(spec!);
    const { context, notEvaluated } = resolveScope(
      { requested: { targets: ["conformance"] }, declared: [...ALL_TARGETS] },
      ["model", "conformance", "implementation"],
      { analysis: spec!.analysis },
    );
    const stub: UXAdapter = {
      setup: async () => [],
      reset: async () => [],
      execute: async () => [],
      act: async () => [],
      observe: async () => ({
        observation: {
          state: { values: [{ variable: "flag", value: observedValue }] },
          provenance: "runner" as const,
        },
        diagnostics: [],
      }),
      read: async () => ({ value: observedValue, diagnostics: [] }),
      selfTest: async () => [],
      teardown: async () => [],
    };
    const rt = await runRuntimeChecks(graph, binding, CONFIG, context, stub);
    return { rt, scopeNE: notEvaluated };
  };

  // "a" のみ観測 → t_b 未観測 → required:t_b が INCOMPLETE
  const onlyA = await run("a", ["t_b"]);
  const req = onlyA.rt.notEvaluated.find((n) => n.property === "required:t_b");
  assert.ok(req, `required:t_b must be notEvaluated: ${JSON.stringify(onlyA.rt.notEvaluated)}`);
  assert.equal(req.reason, "INCOMPLETE");
  // 任意分岐の未観測は missingObligations に記録される（PASS は妨げない）
  const confCov = onlyA.rt.coverage.find((c) => c.target === "conformance");
  assert.ok(
    confCov?.missingObligations.some((m) => m.startsWith("branch:")),
    `unexercised branch must appear in missingObligations: ${JSON.stringify(confCov?.missingObligations)}`,
  );
  assert.equal(confCov?.complete, false);

  // attempt0 は未記録の "c"（divergence → replay 発火）、attempt>=1 は "b" を観測。
  // replay 試行で t_b が観測されるため、required:t_b は全試行集計で充足される。
  const diverge = await (async () => {
    const { spec, diagnostics } = validateSpec(mkSpec(["t_b"]));
    assert.equal(diagnostics.length, 0);
    const { graph } = exploreModel(spec!);
    const { context } = resolveScope(
      { requested: { targets: ["conformance"] }, declared: [...ALL_TARGETS] },
      ["model", "conformance", "implementation"],
      { analysis: spec!.analysis },
    );
    let attempt = 0;
    const value = () => (attempt === 0 ? "c" : "b");
    const stub: UXAdapter = {
      setup: async () => [],
      reset: async (a = 0) => {
        attempt = a;
        return [];
      },
      execute: async () => [],
      act: async () => [],
      observe: async () => ({
        observation: {
          state: { values: [{ variable: "flag", value: value() }] },
          provenance: "runner" as const,
        },
        diagnostics: [],
      }),
      read: async () => ({ value: value(), diagnostics: [] }),
      selfTest: async () => [],
      teardown: async () => [],
    };
    return runRuntimeChecks(graph, binding, CONFIG, context, stub);
  })();
  assert.ok(
    !diverge.notEvaluated.some((n) => n.property === "required:t_b"),
    `required:t_b must be satisfied via replay observation: ${JSON.stringify(diverge.notEvaluated)}`,
  );
  const confCovB = diverge.coverage.find((c) => c.target === "conformance");
  assert.ok(
    confCovB?.transitions.some((t) => t.startsWith("t_b@")),
    `t_b must be covered from replay runs: ${JSON.stringify(confCovB?.transitions)}`,
  );
});

test("env nondeterminism: any recorded branch is accepted", async () => {
  const envSpecJson = {
    schemaVersion: "0.1.0",
    kind: "tidal.uxSpec",
    states: [{ id: "flag", domain: ["a", "b"] }],
    initialState: { values: [{ variable: "flag", value: "a" }] },
    events: [{ id: "flip", kind: "env" }],
    transitions: [
      { id: "t_a", event: "flip", when: { op: "literal", value: true },
        set: { flag: { op: "literal", value: "a" } } },
      { id: "t_b", event: "flip", when: { op: "literal", value: true },
        set: { flag: { op: "literal", value: "b" } } },
    ],
    properties: [],
    analysis: { maxStates: 10, maxDepth: 5, maxTransitions: 100 },
  };
  const { spec, diagnostics } = validateSpec(envSpecJson);
  assert.equal(diagnostics.length, 0);
  assert.ok(spec);
  const { graph } = exploreModel(spec!);
  const edgeB = graph.edges.find(
    (e) => e.event === "flip" && e.to.values[0].value === "b",
  )!;
  assert.ok(edgeB, "env branch to 'b' must be recorded");

  const binding: Parameters<typeof runTrace>[1] = {
    schemaVersion: "0.1.0",
    baseUrl: "http://localhost:3000",
    events: [{ event: "flip", actions: [] }],
    observe: [],
    oracles: [],
    setup: [],
    reset: [],
    network: [],
    selfTest: [],
  };
  // env の非決定で初期は "a"、flip 後は "b" を返すスタブアダプター
  let observed = 0;
  const stub: UXAdapter = {
    setup: async () => [],
    reset: async () => [],
    execute: async () => {
      observed = 1;
      return [];
    },
    act: async () => [],
    observe: async () => ({
      observation: {
        state: { values: [{ variable: "flag", value: observed ? "b" : "a" }] },
        provenance: "runner" as const,
      },
      diagnostics: [],
    }),
    read: async () => ({ value: "b", diagnostics: [] }),
    selfTest: async () => [],
    teardown: async () => [],
  };
  const rt = await runTrace(
    {
      initial: graph.initial,
      eventIds: ["flip"],
      obligations: ["env-test"],
      steps: [edgeB],
    },
    binding,
    graph,
    stub,
    [],
    CONFIG,
    0,
  );
  assert.ok(
    !rt.diagnostics.some((d) => d.code === "MODEL_DIVERGENCE"),
    `recorded env branch rejected: ${JSON.stringify(rt.diagnostics)}`,
  );
});
