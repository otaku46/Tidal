import type {
  AbstractState,
  Cause,
  CheckResult,
  Counterexample,
  Diagnostic,
  Evidence,
  ModelGraph,
  ModelStep,
  Observation,
  ReplayResult,
  RunContext,
  RunResults,
} from "./ir.ts";
import { stateKey } from "./eval.ts";
import { findPath } from "./properties.ts";
import type { Binding, ConcreteInput, OracleRule, RuntimeConfig } from "./binding.ts";
import type { UXAdapter } from "./adapter.ts";

// runtime.toml schemas
export interface Trace {
  initial: AbstractState;
  eventIds: string[];
  obligations: string[];
}

export interface Trial {
  trace: Trace;
  config: RuntimeConfig;
  inputs: ConcreteInput[];
}

export interface RuntimeTrace {
  trial: Trial;
  expectedSteps: ModelStep[];
  observations: Observation[];
  oracleResults: ReplayResult[];
  diagnostics: Diagnostic[];
}

// internal: oracle results tagged with their rule
export interface RuntimeTraceResult extends RuntimeTrace {
  oracleHits: { rule: OracleRule; result: ReplayResult }[];
  // 実際に完了したイベント数（observations.length - 1 と同値、観測失敗時は途中まで）
  completedSteps: number;
}

// Planned trace: schema.Trace + intended model steps (internal).
interface PlannedTrace extends Trace {
  steps: ModelStep[];
}

function diag(code: string, message: string): Diagnostic {
  return { code, message };
}

// FR-29: coverage.complete の定義をレポートに明記する
const COVERAGE_DEFINITION =
  "edge-obligation: 各 (from状態, event) 選択点へ最短経路で1トレースを生成し実行する。" +
  "complete は全 obligation がトレース化され最後のイベントまで実行完了したことを意味し、" +
  "同一選択点への異なる経路や env 全分岐の個別実行は保証しない。";

// FR-26/Q8: 反例トレース最小化の既定試行上限
const DEFAULT_MINIMIZE_ATTEMPTS = 8;

// func.generateTraces: coverage obligations → deterministic traces
export function generateTraces(
  graph: ModelGraph,
  binding: Binding,
): { traces: PlannedTrace[]; missing: string[] } {
  const traces: PlannedTrace[] = [];
  const seen = new Set<string>();
  const missing: string[] = [];

  const push = (obligation: string, edge: ModelStep) => {
    const path = findPath(graph, stateKey(edge.from));
    if (!path) {
      missing.push(obligation);
      return;
    }
    const steps = [...path.steps, edge];
    const eventIds = steps.map((s) => s.event);
    const key = `${obligation}|${eventIds.join(",")}`;
    if (seen.has(key)) return;
    seen.add(key);
    traces.push({
      initial: graph.initial,
      eventIds,
      obligations: [obligation],
      steps,
    });
  };

  // obligation は (from 状態, event) の選択点単位。同一イベントが複数の起点状態から
  // 発火する場合、起点ごとの挙動差を検出できるよう全選択点をカバーする。
  // env の非決定など同一 (from, event) の複数行き先は1つの obligation を共有する
  // （conformance は記録済み辺の全候補を許容するため、分岐ごとの個別トレースは張らない）。
  const byChoice = new Map<string, { fromKey: string; edge: ModelStep }>();
  for (const e of graph.edges) {
    const fromKey = stateKey(e.from);
    const key = `${fromKey}\u0000${e.event}`;
    if (!byChoice.has(key)) byChoice.set(key, { fromKey, edge: e });
  }
  const obligationEdges = [...byChoice.values()].sort((a, b) =>
    a.fromKey === b.fromKey
      ? a.edge.event < b.edge.event
        ? -1
        : 1
      : a.fromKey < b.fromKey
        ? -1
        : 1,
  );
  for (const { fromKey, edge } of obligationEdges) {
    push(`event:${edge.event}@${fromKey}`, edge);
  }

  for (const rule of binding.oracles) {
    const steps = oracleSteps(graph, binding, rule);
    if (!steps) {
      missing.push(`oracle:${rule.property}`);
      continue;
    }
    const eventIds = steps.map((s) => s.event);
    const key = `oracle:${rule.property}:${rule.inputId}|${eventIds.join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    traces.push({
      initial: graph.initial,
      eventIds,
      obligations: [`oracle:${rule.property}:${rule.inputId}`],
      steps,
    });
  }

  traces.sort((a, b) => a.eventIds.join(",").localeCompare(b.eventIds.join(",")));
  return { traces, missing };
}

// BFS path of steps from fromKey until predicate(stateKey) holds,
// then append one edge matching `event`. Returns null if unreachable.
function bfsToEvent(
  graph: ModelGraph,
  fromKey: string,
  event: string,
): ModelStep[] | null {
  const prev = new Map<string, { key: string; step: ModelStep }>();
  const visited = new Set([fromKey]);
  const queue = [fromKey];
  while (queue.length) {
    const k = queue.shift()!;
    for (const e of graph.edges) {
      if (stateKey(e.from) !== k) continue;
      const tk = stateKey(e.to);
      if (e.event === event) {
        // reconstruct path to k, then append e
        const steps: ModelStep[] = [e];
        let cur = k;
        while (cur !== fromKey) {
          const link = prev.get(cur);
          if (!link) return null;
          steps.unshift(link.step);
          cur = link.key;
        }
        return steps;
      }
      if (!visited.has(tk)) {
        visited.add(tk);
        prev.set(tk, { key: k, step: e });
        queue.push(tk);
      }
    }
  }
  return null;
}

// oracle obligation trace: feed the concrete input, then reach afterEvent.
function oracleSteps(
  graph: ModelGraph,
  binding: Binding,
  rule: OracleRule,
): ModelStep[] | null {
  // events whose actions consume rule.inputId
  const feedEvents = [
    ...new Set(
      binding.events
        .filter((b) => b.actions.some((a) => a.inputId === rule.inputId))
        .map((b) => b.event),
    ),
  ].sort();

  const candidates: ModelStep[][] = [];
  if (feedEvents.length > 0) {
    for (const fe of feedEvents) {
      const feedEdge = graph.edges.find((e) => e.event === fe);
      if (!feedEdge) continue;
      const pre = findPath(graph, stateKey(feedEdge.from));
      if (!pre) continue;
      const mid = [...pre.steps, feedEdge];
      const midKey = stateKey(feedEdge.to);
      const rest = bfsToEvent(graph, midKey, rule.afterEvent);
      if (rest) candidates.push([...mid, ...rest]);
    }
  } else {
    // no feed action: just reach afterEvent from initial
    const rest = bfsToEvent(graph, stateKey(graph.initial), rule.afterEvent);
    if (rest) candidates.push(rest);
  }
  if (candidates.length === 0) return null;
  // deterministic: shortest, then lexicographic event sequence
  candidates.sort((a, b) => {
    if (a.length !== b.length) return a.length - b.length;
    const ea = a.map((s) => s.event).join(",");
    const eb = b.map((s) => s.event).join(",");
    return ea < eb ? -1 : ea > eb ? 1 : 0;
  });
  return candidates[0];
}

export function makeInputs(binding: Binding, seed: string): ConcreteInput[] {
  const ids = new Set<string>();
  for (const r of binding.oracles) ids.add(r.inputId);
  for (const e of binding.events) {
    for (const a of e.actions) if (a.inputId) ids.add(a.inputId);
  }
  return [...ids].sort().map((id) => ({ id, value: `tidal-${seed}-${id}` }));
}

// func.evaluateOracle: stored concrete input vs direct read (FR-17)
export async function evaluateOracle(
  rule: OracleRule,
  trial: Trial,
  adapter: UXAdapter,
  attempt: number,
): Promise<ReplayResult> {
  const input = trial.inputs.find((i) => i.id === rule.inputId);
  const res = await adapter.read(rule.actual);
  if (res.diagnostics.length > 0 || res.value === undefined) {
    return {
      attempt,
      outcome: "ERROR",
      expectedValue: input?.value,
      diagnostic: res.diagnostics[0] ?? diag("ADAPTER_ERROR", "oracle read failed"),
    };
  }
  return {
    attempt,
    outcome: res.value === input?.value ? "MATCH" : "MISMATCH",
    expectedValue: input?.value,
    actualValue: res.value,
  };
}

// func.runTrace: apply events, observe each step, compare with model candidates
export async function runTrace(
  planned: PlannedTrace,
  binding: Binding,
  graph: ModelGraph,
  adapter: UXAdapter,
  inputs: ConcreteInput[],
  config: RuntimeConfig,
  attempt = 0,
): Promise<RuntimeTraceResult> {
  const trial: Trial = {
    trace: {
      initial: planned.initial,
      eventIds: planned.eventIds,
      obligations: planned.obligations,
    },
    config,
    inputs,
  };
  const observations: Observation[] = [];
  const oracleResults: ReplayResult[] = [];
  const oracleHits: { rule: OracleRule; result: ReplayResult }[] = [];
  const diagnostics: Diagnostic[] = [];
  const boundByEvent = new Map(binding.events.map((b) => [b.event, b]));
  const rulesByAfterEvent = new Map<string, OracleRule[]>();
  for (const r of binding.oracles) {
    const list = rulesByAfterEvent.get(r.afterEvent) ?? [];
    list.push(r);
    rulesByAfterEvent.set(r.afterEvent, list);
  }

  const obs0 = await adapter.observe();
  diagnostics.push(...obs0.diagnostics);
  if (obs0.diagnostics.length === 0 && obs0.observation) {
    const o0 = obs0.observation;
    observations.push(o0);
    if (stateKey(o0.state) !== stateKey(planned.initial)) {
      diagnostics.push(
        diag(
          "MODEL_DIVERGENCE",
          `初期状態不一致: model=${stateKey(planned.initial)} observed=${stateKey(o0.state)}`,
        ),
      );
    }
  } else {
    diagnostics.push(diag("ADAPTER_ERROR", "初期観測に失敗しました"));
    return { trial, expectedSteps: planned.steps, observations, oracleResults, diagnostics, oracleHits, completedSteps: 0 };
  }

  let cursorKey = stateKey(planned.initial);
  const fedInputs = new Set<string>();

  for (const step of planned.steps) {
    const bound = boundByEvent.get(step.event);
    if (!bound) {
      diagnostics.push(diag("ADAPTER_ERROR", `binding にイベント対応がありません: ${step.event}`));
      break;
    }
    for (const a of bound.actions) {
      if (a.inputId) fedInputs.add(a.inputId);
    }
    const execDiags = await adapter.execute(bound, inputs);
    diagnostics.push(...execDiags);
    if (execDiags.some((d) => d.code === "ADAPTER_ERROR")) break;

    // appMarker: 実装側の応答証跡。読めれば provenance="app"、
    // 読めなければ来歴不明の変化として記録する (FR-14)。
    let nextProvenance: Observation["provenance"] | undefined;
    if (bound.appMarker) {
      const m = await adapter.read(bound.appMarker);
      if (m.diagnostics.length > 0 || m.value === undefined) {
        diagnostics.push(
          diag("UNEXPLAINED_CHANGE", `appMarker の読み取りに失敗: ${step.event}`),
        );
        nextProvenance = "unexplained";
      } else {
        nextProvenance = "app";
      }
    }

    const obs = await adapter.observe();
    diagnostics.push(...obs.diagnostics);
    if (obs.diagnostics.length > 0 || !obs.observation) break;
    const o = obs.observation;
    if (nextProvenance) {
      o.provenance = nextProvenance;
      nextProvenance = undefined;
    }
    observations.push(o);
    if (o.provenance === "unexplained") {
      diagnostics.push(diag("UNEXPLAINED_CHANGE", `来歴不明の変化: ${step.event}`));
    }

    const obsKey = stateKey(o.state);
    // 許容されるのはモデルに記録された辺のみ（env の非決定分岐・set:{} 自己ループを含む）。
    // イベントを無視した実装は「無変化」としては通さない (AC-04)。
    const candidates = new Set(
      graph.edges
        .filter((e) => e.event === step.event && stateKey(e.from) === cursorKey)
        .map((e) => stateKey(e.to)),
    );
    if (!candidates.has(obsKey)) {
      diagnostics.push(
        diag(
          "MODEL_DIVERGENCE",
          `イベント ${step.event} 後の状態不一致: candidates={${[...candidates].join(",")}} observed=${obsKey}`,
        ),
      );
    }
    cursorKey = obsKey;

    for (const rule of rulesByAfterEvent.get(step.event) ?? []) {
      // oracle は具体入力が実際に供給された後でのみ評価する
      if (!fedInputs.has(rule.inputId)) continue;
      const r = await evaluateOracle(rule, trial, adapter, attempt);
      oracleResults.push(r);
      oracleHits.push({ rule, result: r });
      // オラクル読み取り障害は adapter 依存の実行障害として run.diagnostics にも流す
      if (r.outcome === "ERROR" && r.diagnostic) {
        diagnostics.push(r.diagnostic);
      }
    }
  }

  // observations[0] は初期状態、以降1観測=1完了イベント
  const completedSteps = Math.min(
    planned.steps.length,
    Math.max(0, observations.length - 1),
  );
  return { trial, expectedSteps: planned.steps, observations, oracleResults, diagnostics, oracleHits, completedSteps };
}

// func.replayViolation: same trace / inputs / conditions, N attempts (FR-18)
export async function replayViolation(
  planned: PlannedTrace,
  binding: Binding,
  graph: ModelGraph,
  adapter: UXAdapter,
  inputs: ConcreteInput[],
  config: RuntimeConfig,
): Promise<RuntimeTraceResult[]> {
  const runs: RuntimeTraceResult[] = [];
  for (let a = 1; a <= config.replayAttempts; a++) {
    await adapter.reset(a);
    runs.push(await runTrace(planned, binding, graph, adapter, inputs, config, a));
  }
  return runs;
}

// func.minimizeTrace: 反例トレースからステップを貪欲に削除し、
// reproduces が真を返す最小のトレースを探す。試行回数は minimizeAttempts で上限化する。
// 戻り値の rt は採用されたトレースの再現ラン（削除に成功しなければ baseRt）。
async function minimizeTrace(
  planned: PlannedTrace,
  baseRt: RuntimeTraceResult,
  reproduces: (run: RuntimeTraceResult) => boolean,
  binding: Binding,
  graph: ModelGraph,
  adapter: UXAdapter,
  inputs: ConcreteInput[],
  config: RuntimeConfig,
): Promise<{ planned: PlannedTrace; rt: RuntimeTraceResult; minimized: boolean }> {
  const budget = config.minimizeAttempts ?? DEFAULT_MINIMIZE_ATTEMPTS;
  let current = planned;
  let currentRt = baseRt;
  if (budget <= 0) return { planned: current, rt: currentRt, minimized: false };

  let attempts = 0;
  let i = 0;
  while (i < current.steps.length && attempts < budget) {
    const steps = current.steps.filter((_, j) => j !== i);
    if (steps.length === 0) break;
    attempts++;
    const cand: PlannedTrace = {
      ...current,
      steps,
      eventIds: steps.map((s) => s.event),
    };
    await adapter.reset(0);
    const run = await runTrace(cand, binding, graph, adapter, inputs, config, 0);
    if (reproduces(run)) {
      current = cand;
      currentRt = run;
      // 削除成功時は同じ index を再試行する（詰まった次のステップを試す）
    } else {
      i++;
    }
  }
  return {
    planned: current,
    rt: currentRt,
    minimized: current.steps.length < planned.steps.length,
  };
}

// 明示的な決定表:
//   hasError && hasMismatch && !hasMatch → INCONCLUSIVE (ADAPTER_ERROR)
//   hasError (その他)                  → ERROR (ADAPTER_ERROR)
//   !hasError && hasMismatch && !hasMatch → CONFIRMED
//   !hasError && hasMatch && hasMismatch  → FLAKY
//   それ以外                            → PASS
function oracleCheckResult(
  property: string,
  hits: { result: ReplayResult }[],
  rt: RuntimeTraceResult,
  minimized = false,
): CheckResult {
  const all: ReplayResult[] = hits.map((h) => h.result);
  const outcomes = all.map((r) => r.outcome);
  const hasError = outcomes.includes("ERROR");
  const hasMatch = outcomes.includes("MATCH");
  const hasMismatch = outcomes.includes("MISMATCH");

  let verdict: CheckResult["verdict"];
  let causes: Cause[] = [];
  let evidence: Evidence[] = [];

  if (hasMismatch) {
    const mism = all.find((r) => r.outcome === "MISMATCH")!;
    const counterexample: Counterexample = {
      initial: rt.trial.trace.initial,
      events: rt.trial.trace.eventIds,
      modelSteps: rt.expectedSteps,
      observations: rt.observations,
      expectedValue: mism.expectedValue,
      actualValue: mism.actualValue,
      minimized,
    };
    evidence = [
      {
        id: `oracle:${property}`,
        kind: "INDEPENDENT_ORACLE",
        counterexample,
        replay: all,
        dependencies: ["adapter", "oracle"],
      },
    ];
  }

  if (hasError) {
    if (hasMismatch && !hasMatch) {
      verdict = "INCONCLUSIVE";
      causes = ["ADAPTER_ERROR"];
    } else {
      verdict = "ERROR";
      causes = ["ADAPTER_ERROR"];
    }
  } else if (hasMismatch && !hasMatch) {
    verdict = "CONFIRMED";
  } else if (hasMatch && hasMismatch) {
    verdict = "FLAKY";
  } else {
    verdict = "PASS";
  }

  return { target: "implementation", property, verdict, causes, evidence };
}

// func.runRuntimeChecks
export async function runRuntimeChecks(
  graph: ModelGraph,
  binding: Binding,
  config: RuntimeConfig,
  context: RunContext,
  adapter: UXAdapter,
): Promise<RunResults> {
  const results: CheckResult[] = [];
  const diagnostics: Diagnostic[] = [];
  const notEvaluated: RunResults["notEvaluated"] = [];
  const coverage: RunResults["coverage"] = [];

  const effective = new Set(context.effectiveTargets);
  const wantConf = effective.has("conformance");
  const wantImpl = effective.has("implementation");
  if (!wantConf && !wantImpl) {
    return { context, results, coverage, diagnostics, notEvaluated };
  }

  // setup → FR-15 adapter self-test (self-test needs a live adapter/page)
  const setupDiags = await adapter.setup();
  diagnostics.push(...setupDiags);
  if (setupDiags.some((d) => d.code === "ADAPTER_ERROR")) {
    for (const t of ["conformance", "implementation"] as const) {
      if (effective.has(t)) {
        results.push({
          target: t,
          property: "adapter.setup",
          verdict: "ERROR",
          causes: ["ADAPTER_ERROR"],
          evidence: [],
        });
      }
    }
    await adapter.teardown();
    return { context, results, coverage, diagnostics, notEvaluated };
  }

  const selfTestDiags = await adapter.selfTest();
  if (selfTestDiags.length > 0) {
    diagnostics.push(...selfTestDiags);
    for (const t of ["conformance", "implementation"] as const) {
      if (effective.has(t)) {
        results.push({
          target: t,
          property: "adapter.selfTest",
          verdict: "ERROR",
          causes: ["ADAPTER_ERROR"],
          evidence: [],
        });
      }
    }
    await adapter.teardown();
    return { context, results, coverage, diagnostics, notEvaluated };
  }

  const { traces, missing } = generateTraces(graph, binding);
  for (const m of missing) {
    const t: "conformance" | "implementation" = m.startsWith("oracle:") ? "implementation" : "conformance";
    if (effective.has(t)) {
      notEvaluated.push({ target: t, property: m, reason: "INCOMPLETE", cause: "COVERAGE_SHORT" });
    }
  }

  const inputs = makeInputs(binding, config.seed);
  const conformanceResults: CheckResult[] = [];
  const incompleteObligations = new Set<string>();
  // property -> attempt0 のヒット（結果・トレース・計画を保持）
  const oracleAcc = new Map<
    string,
    { hits: { result: ReplayResult; rt: RuntimeTraceResult; planned: PlannedTrace }[] }
  >();

  for (const [ti, planned] of traces.entries()) {
    await adapter.reset(0);
    const rt = await runTrace(planned, binding, graph, adapter, inputs, config, 0);
    diagnostics.push(...rt.diagnostics.filter((d) => d.code !== "MODEL_DIVERGENCE" && d.code !== "UNEXPLAINED_CHANGE"));

    // 途中で止まったトレースの obligation は未完了として記録する（FR-29）
    if (rt.completedSteps < planned.steps.length) {
      const hadAdapterErr = rt.diagnostics.some((d) => d.code === "ADAPTER_ERROR");
      for (const ob of planned.obligations) {
        const t: "conformance" | "implementation" = ob.startsWith("oracle:")
          ? "implementation"
          : "conformance";
        if (!effective.has(t)) continue;
        notEvaluated.push({
          target: t,
          property: ob,
          reason: "INCOMPLETE",
          cause: hadAdapterErr ? "ADAPTER_ERROR" : "COVERAGE_SHORT",
        });
        incompleteObligations.add(ob);
      }
    }

    if (wantConf) {
      const divs = rt.diagnostics.filter((d) => d.code === "MODEL_DIVERGENCE");
      const unexplained = rt.diagnostics.filter((d) => d.code === "UNEXPLAINED_CHANGE");
      const adapterErrs = rt.diagnostics.filter((d) => d.code === "ADAPTER_ERROR");
      const property = `trace:${ti}`;
      // 不一致の再現性を再実行で記録する（verdict は INCONCLUSIVE のまま変えない）
      const replayResults: ReplayResult[] = [];
      let cxRt = rt;
      let minimized = false;
      const hasDivergence = divs.length > 0 || unexplained.length > 0;
      if (hasDivergence && adapterErrs.length === 0) {
        if (config.replayAttempts > 0) {
          const runs = await replayViolation(
            planned, binding, graph, adapter, inputs, config,
          );
          for (const [i, run] of runs.entries()) {
            const aerr = run.diagnostics.some((d) => d.code === "ADAPTER_ERROR");
            const repro = run.diagnostics.some(
              (d) => d.code === "MODEL_DIVERGENCE" || d.code === "UNEXPLAINED_CHANGE",
            );
            replayResults.push({
              attempt: i + 1,
              outcome: aerr ? "ERROR" : repro ? "MISMATCH" : "MATCH",
            });
          }
        }
        // 同一の不一致（診断メッセージ一致）だけを再現とみなす。
        // 別原因の不一致にすり替わる最小化を防ぐ。
        const targetMsgs = new Set([...divs, ...unexplained].map((d) => d.message));
        const min = await minimizeTrace(
          planned,
          rt,
          (run) =>
            !run.diagnostics.some((d) => d.code === "ADAPTER_ERROR") &&
            run.diagnostics.some((d) => targetMsgs.has(d.message)),
          binding, graph, adapter, inputs, config,
        );
        cxRt = min.rt;
        minimized = min.minimized;
      }
      const evidence: Evidence[] = [];
      if (hasDivergence) {
        evidence.push({
          id: `${property}:mismatch`,
          kind: "OBSERVATION_MISMATCH",
          counterexample: {
            initial: cxRt.trial.trace.initial,
            events: cxRt.trial.trace.eventIds,
            modelSteps: cxRt.expectedSteps,
            observations: cxRt.observations,
            minimized,
          },
          replay: replayResults,
          dependencies: ["adapter"],
        });
      }
      let verdict: CheckResult["verdict"];
      let causes: Cause[] = [];
      if (adapterErrs.length > 0) {
        verdict = "ERROR";
        causes = ["ADAPTER_ERROR"];
      } else if (divs.length > 0) {
        verdict = "INCONCLUSIVE";
        causes = ["MODEL_DIVERGENCE"];
      } else if (unexplained.length > 0) {
        verdict = "INCONCLUSIVE";
        causes = ["UNEXPLAINED_CHANGE"];
      } else {
        verdict = "PASS";
      }
      conformanceResults.push({ target: "conformance", property, verdict, causes, evidence });
    }

    if (wantImpl) {
      for (const h of rt.oracleHits) {
        const acc = oracleAcc.get(h.rule.property) ?? { hits: [] };
        acc.hits.push({ result: h.result, rt, planned });
        oracleAcc.set(h.rule.property, acc);
      }
    }
  }

  results.push(...conformanceResults);

  if (wantImpl) {
    for (const [property, acc] of [...oracleAcc.entries()].sort()) {
      // property 単位で最初のミスマッチを記録し、そのトレースだけを再実行する
      const firstMismatch = acc.hits.find((h) => h.result.outcome === "MISMATCH");
      if (firstMismatch && config.replayAttempts > 0) {
        const replays = await replayViolation(
          firstMismatch.planned,
          binding,
          graph,
          adapter,
          inputs,
          config,
        );
        for (const run of replays) {
          for (const rh of run.oracleHits) {
            if (rh.rule.property === property) {
              acc.hits.push({
                result: rh.result,
                rt: run,
                planned: firstMismatch.planned,
              });
            }
          }
        }
      }
      // 反例にはミスマッチを出したトレースを使う（なければ最初のヒット）
      const firstRt = firstMismatch?.rt ?? acc.hits[0].rt;
      let cxRt = firstRt;
      let minimized = false;
      if (firstMismatch) {
        // FR-26/Q8: 不一致が再現する範囲でステップを削減した反例を使う
        const min = await minimizeTrace(
          firstMismatch.planned,
          firstRt,
          (run) =>
            run.oracleHits.some(
              (h) => h.rule.property === property && h.result.outcome === "MISMATCH",
            ),
          binding, graph, adapter, inputs, config,
        );
        cxRt = min.rt;
        minimized = min.minimized;
      }
      results.push(
        oracleCheckResult(
          property,
          acc.hits.map((h) => ({ result: h.result })),
          cxRt,
          minimized,
        ),
      );
    }
    // oracle rules never exercised → not evaluated
    for (const rule of binding.oracles) {
      if (!oracleAcc.has(rule.property)) {
        notEvaluated.push({
          target: "implementation",
          property: rule.property,
          reason: "INCOMPLETE",
          cause: "COVERAGE_SHORT",
        });
      }
    }
  }

  const observedStates = new Map<string, AbstractState>();
  const coveredTransitions = new Set<string>();
  const coveredEvents = new Set<string>();
  for (const t of traces) {
    for (const s of t.steps) {
      observedStates.set(stateKey(s.to), s.to);
      coveredTransitions.add(s.transition);
      coveredEvents.add(s.event);
    }
  }

  const confObligations = missing.filter((m) => !m.startsWith("oracle:"));
  const confMissing = [
    ...confObligations,
    ...[...incompleteObligations].filter((o) => !o.startsWith("oracle:")),
  ];
  if (wantConf) {
    coverage.push({
      target: "conformance",
      states: [...observedStates.values()],
      transitions: [...coveredTransitions],
      events: [...coveredEvents].sort(),
      evaluatedProperties: conformanceResults.map((r) => r.property),
      missingObligations: confMissing,
      complete: confMissing.length === 0,
      definition: COVERAGE_DEFINITION,
    });
  }
  const implMissing = [
    ...missing.filter((m) => m.startsWith("oracle:")),
    ...binding.oracles
      .filter((r) => !oracleAcc.has(r.property))
      .map((r) => `oracle:${r.property}`),
    ...[...incompleteObligations].filter((o) => o.startsWith("oracle:")),
  ];
  if (wantImpl) {
    coverage.push({
      target: "implementation",
      states: [...observedStates.values()],
      transitions: [...coveredTransitions],
      events: [...coveredEvents].sort(),
      evaluatedProperties: [...oracleAcc.keys()],
      missingObligations: implMissing,
      complete: implMissing.length === 0,
      definition: COVERAGE_DEFINITION,
    });
  }

  await adapter.teardown();
  return { context, results, coverage, diagnostics, notEvaluated };
}
