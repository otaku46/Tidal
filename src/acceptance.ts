import type {
  Diagnostic,
  FrameworkFixture,
  GoldenExpectation,
  Report,
  RunResults,
  RunScope,
  RunSelection,
  UxSpec,
} from "./ir.ts";
import { validateSpec } from "./spec.ts";
import { exploreModel } from "./model.ts";
import { checkProperties } from "./properties.ts";
import { aggregateResults, ALL_TARGETS, resolveScope } from "./reporting.ts";
import { resolveBinding, type RuntimeConfig } from "./binding.ts";
import { runRuntimeChecks } from "./runtime.ts";
import { checkVerdictInvariants } from "./golden.ts";
import { PlaywrightAdapter } from "./playwright-adapter.ts";
import type { UXAdapter } from "./adapter.ts";
import type { Binding } from "./binding.ts";

function diag(code: string, message: string): Diagnostic {
  return { code, message };
}

export type AdapterFactory = (
  binding: Binding,
  config: RuntimeConfig,
) => UXAdapter | Promise<UXAdapter>;

// func.verifyFrameworkFixtures (design/acceptance.toml, AC-08):
// 同一の UX 仕様を React/Solid/Svelte フィクスチャに適用し、
// 共通アダプターで検証する。fixture.binding 側で baseUrl/ロケーターを差し替える。
export async function verifyFrameworkFixtures(
  spec: UxSpec,
  fixture: FrameworkFixture,
  expected: GoldenExpectation,
  options: {
    config?: Partial<RuntimeConfig>;
    adapterFactory?: AdapterFactory;
  } = {},
): Promise<Diagnostic[]> {
  const diags: Diagnostic[] = [];
  const { spec: validated, diagnostics } = validateSpec(spec);
  diags.push(...diagnostics);
  if (!validated) return diags;

  const config: RuntimeConfig = {
    allowedOrigins: ["http://localhost:4173"],
    timeoutMs: 5000,
    replayAttempts: 1,
    seed: "acceptance",
    ...options.config,
  };
  const { binding, diagnostics: bd } = resolveBinding(fixture.binding, validated, config);
  diags.push(...bd);
  if (!binding) return diags;

  const scope: RunScope = {};
  const selection: RunSelection = { requested: scope, declared: [...ALL_TARGETS] };
  const { context, notEvaluated } = resolveScope(
    selection,
    ["model", "conformance", "implementation"],
    { analysis: validated.analysis, seed: "acceptance" },
  );
  const run: RunResults = {
    context,
    results: [],
    coverage: [],
    diagnostics: [],
    notEvaluated: [...notEvaluated],
  };

  const { graph } = exploreModel(validated);
  const checked = checkProperties(validated, graph, context);
  run.results.push(...checked.results);
  run.coverage.push(...checked.coverage);
  run.diagnostics.push(...checked.diagnostics);

  const adapter =
    (await options.adapterFactory?.(binding, config)) ??
    new PlaywrightAdapter(binding, config);
  const rt = await runRuntimeChecks(graph, binding, config, context, adapter);
  run.results.push(...rt.results);
  run.coverage.push(...rt.coverage);
  run.diagnostics.push(...rt.diagnostics);
  run.notEvaluated.push(...rt.notEvaluated);

  const report: Report = aggregateResults(run);
  // GoldenExpectation の全項目（overall/exitCode/target/cause/evidenceKind/
  // requiredEvidenceFields）と I1〜I5 不変条件を照合する
  for (const p of checkVerdictInvariants(report, expected)) {
    diags.push({ ...p, message: `${fixture.framework}: ${p.message}` });
  }
  return diags;
}
