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
import { runRuntimeChecks } from "../src/runtime.ts";
import { makeMockAdapter } from "../src/fixtures.ts";
import { runGoldenCases, type GoldenRunner } from "../src/golden.ts";
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
];

test("golden suite: draft-retention cases", async () => {
  const diags = await runGoldenCases(cases, runner);
  assert.deepEqual(diags, []);
});
