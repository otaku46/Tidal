import type {
  Cause,
  CheckResult,
  Counterexample,
  Diagnostic,
  Evidence,
  NotEvaluated,
  ReplayResult,
  Report,
  RunContext,
  RunResults,
  RunScope,
  RunSelection,
  Target,
  TargetResult,
  Verdict,
} from "./ir.ts";

export const ALL_TARGETS: Target[] = ["model", "conformance", "implementation"];

// 仕様・式・binding の検証失敗は実行障害として ERROR に昇格する (FR-19)
const FATAL_DIAG_PREFIXES = ["SPEC_", "EXPR_", "BINDING_"];
function isFatalDiagnostic(d: Diagnostic): boolean {
  return FATAL_DIAG_PREFIXES.some((p) => d.code.startsWith(p));
}

const VERDICT_EXIT: Record<Verdict, number> = {
  PASS: 0,
  CONFIRMED: 1,
  INCONCLUSIVE: 2,
  FLAKY: 2,
  ERROR: 3,
};

// func.resolveScope: requested scope ∩ declared targets.
// 指定外 → NOT_REQUESTED。要求されたが実行不能 → BLOCKED。
export function resolveScope(
  selection: RunSelection,
  implemented: Target[] = ["model"],
  extras: {
    analysis?: RunContext["analysis"];
    seed?: string;
    environment?: unknown;
    reproduction?: unknown;
  } = {},
): { context: RunContext; notEvaluated: NotEvaluated[] } {
  const requested = selection.requested.targets;
  const declared = selection.declared;
  const effective = new Set<Target>();
  const notEvaluated: NotEvaluated[] = [];

  if (requested === undefined || requested.length === 0) {
    // normal run: all declared targets
    for (const t of declared) effective.add(t);
  } else {
    for (const t of requested) {
      if (!declared.includes(t)) {
        notEvaluated.push({ target: t, reason: "NOT_REQUESTED" });
      } else {
        effective.add(t);
      }
    }
    for (const t of declared) {
      if (!requested.includes(t)) {
        notEvaluated.push({ target: t, reason: "NOT_REQUESTED" });
      }
    }
  }

  // requested+declared but not implemented → BLOCKED
  for (const t of [...effective]) {
    if (!implemented.includes(t)) {
      effective.delete(t);
      notEvaluated.push({ target: t, reason: "BLOCKED" });
    }
  }

  const context: RunContext = {
    scope: selection.requested,
    declaredTargets: declared,
    effectiveTargets: [...effective].sort(),
    analysis: extras.analysis,
    seed: extras.seed,
    environment: extras.environment,
    reproduction: extras.reproduction,
  };
  return { context, notEvaluated };
}

function evidenceValidFor(
  result: CheckResult,
  evidence: Evidence,
  healthyDependencies: Set<string>,
): boolean {
  if (evidence.dependencies.some((d) => !healthyDependencies.has(d))) return false;
  if (result.target === "model") return evidence.kind === "MODEL_COUNTEREXAMPLE";
  if (result.target === "implementation") return evidence.kind === "INDEPENDENT_ORACLE";
  // conformance: observation mismatch alone never confirms
  return false;
}

interface TargetState {
  confirmed: boolean;
  error: boolean;
  flaky: boolean;
  inconclusive: boolean;
  evaluated: boolean;
}

// func.aggregateResults: FR-19〜24 集約規則
// CONFIRMED > ERROR > FLAKY > INCONCLUSIVE > PASS
export function aggregateResults(
  run: RunResults,
  schemaVersion = "0.1.0",
): Report {
  const byTarget = new Map<Target, CheckResult[]>();
  for (const r of run.results) {
    const list = byTarget.get(r.target) ?? [];
    list.push(r);
    byTarget.set(r.target, list);
  }

  // dependency health: "model" engine is healthy unless diagnostics say otherwise;
  // adapter-dependent checks are unhealthy when ADAPTER_ERROR diagnostics exist.
  const adapterHealthy = !run.diagnostics.some(
    (d) => d.code === "ADAPTER_ERROR" || d.code === "ADAPTER_SELFTEST_FAILED",
  );
  const fatalDiagnostics = run.diagnostics.filter(isFatalDiagnostic);
  const healthyDependencies = new Set<string>(["model", "spec", "oracle"]);
  if (adapterHealthy) healthyDependencies.add("adapter");

  const states = new Map<Target, TargetState>();
  for (const t of ALL_TARGETS) {
    states.set(t, {
      confirmed: false,
      error: false,
      flaky: false,
      inconclusive: false,
      evaluated: false,
    });
  }

  const confirmedViolations: CheckResult[] = [];
  const allEvidence: Evidence[] = [];
  const allCounterexamples: Counterexample[] = [];
  const allReplays: ReplayResult[] = [];

  for (const [target, results] of byTarget) {
    const st = states.get(target)!;
    st.evaluated = true;
    for (const r of results) {
      allEvidence.push(...r.evidence);
      for (const e of r.evidence) {
        allCounterexamples.push(e.counterexample);
        allReplays.push(...e.replay);
      }
      switch (r.verdict) {
        case "CONFIRMED": {
          const valid = r.evidence.some((e) => evidenceValidFor(r, e, healthyDependencies));
          if (valid) {
            st.confirmed = true;
            confirmedViolations.push(r);
          } else {
            // 確定証拠なし → INCONCLUSIVE
            st.inconclusive = true;
          }
          break;
        }
        case "ERROR":
          st.error = true;
          break;
        case "FLAKY":
          st.flaky = true;
          break;
        case "INCONCLUSIVE":
          st.inconclusive = true;
          break;
        case "PASS":
          break;
      }
    }
  }

  // 未評価の要求対象 → INCONCLUSIVE 候補（NOT_REQUESTED は影響しない）
  const hasBlocked = run.notEvaluated.some(
    (ne) => ne.reason === "BLOCKED" || ne.reason === "INCOMPLETE",
  );

  // FR-24: 空の明示スコープは入力エラー。要求があったのに effective が空なら
  // 未完了として INCONCLUSIVE（無条件 PASS にしない）。
  const requestedTargets = run.context.scope.targets;
  const emptyExplicitScope =
    requestedTargets !== undefined && requestedTargets.length === 0;
  const requestedButNothingEffective =
    requestedTargets !== undefined &&
    requestedTargets.length > 0 &&
    run.context.effectiveTargets.length === 0;

  // target 別 verdict
  const targetResults: TargetResult[] = ALL_TARGETS.map((t) => {
    const st = states.get(t)!;
    const props = byTarget.get(t) ?? [];
    let verdict: Verdict | undefined;
    if (st.confirmed) verdict = "CONFIRMED";
    else if (st.error) verdict = "ERROR";
    else if (st.flaky) verdict = "FLAKY";
    else if (st.inconclusive) verdict = "INCONCLUSIVE";
    else if (st.evaluated) verdict = "PASS";
    return { target: t, verdict, properties: props };
  });

  // overall
  const anyConfirmed = [...states.values()].some((s) => s.confirmed);
  const anyError =
    [...states.values()].some((s) => s.error) ||
    !adapterHealthy ||
    fatalDiagnostics.length > 0 ||
    emptyExplicitScope;
  const anyFlaky = [...states.values()].some((s) => s.flaky);
  const anyInconclusive =
    [...states.values()].some((s) => s.inconclusive) ||
    hasBlocked ||
    requestedButNothingEffective;

  let overall: Verdict;
  if (anyConfirmed) overall = "CONFIRMED";
  else if (anyError) overall = "ERROR";
  else if (anyFlaky) overall = "FLAKY";
  else if (anyInconclusive) overall = "INCONCLUSIVE";
  else overall = "PASS";

  const notEvaluated = [...run.notEvaluated];
  // ensure scope-level not-evaluated entries are included by caller via run.notEvaluated

  return {
    schemaVersion,
    context: run.context,
    overall,
    exitCode: VERDICT_EXIT[overall],
    targets: targetResults,
    confirmedViolations,
    errors: run.diagnostics,
    notEvaluated: run.notEvaluated,
    coverage: run.coverage,
    evidence: allEvidence,
    counterexamples: allCounterexamples,
    replayResults: allReplays,
  };
}
