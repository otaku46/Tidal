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
  Property,
  RunContext,
  RunResults,
  UxSpec,
} from "./ir.ts";
import { evaluateExpression, normalizeState, stateKey, stateValue, varsById } from "./eval.ts";

function satisfies(expr: Property["from"], state: AbstractState): boolean {
  const r = evaluateExpression(expr, state);
  return r.value === true;
}

// BFS shortest path from graph.initial to targetKey over recorded edges.
export function findPath(
  graph: ModelGraph,
  targetKey: string,
): { events: string[]; steps: ModelStep[] } | null {
  const startKey = stateKey(graph.initial);
  if (startKey === targetKey) return { events: [], steps: [] };
  const prev = new Map<string, { key: string; step: ModelStep }>();
  const visited = new Set([startKey]);
  const queue = [startKey];
  while (queue.length) {
    const k = queue.shift()!;
    for (const e of graph.edges) {
      if (stateKey(e.from) !== k) continue;
      const tk = stateKey(e.to);
      if (visited.has(tk)) continue;
      visited.add(tk);
      prev.set(tk, { key: k, step: e });
      if (tk === targetKey) {
        const events: string[] = [];
        const steps: ModelStep[] = [];
        let cur = tk;
        while (cur !== startKey) {
          const link = prev.get(cur)!;
          events.unshift(link.step.event);
          steps.unshift(link.step);
          cur = link.key;
        }
        return { events, steps };
      }
      queue.push(tk);
    }
  }
  return null;
}

// All states reachable from `fromKey` following edges. Includes `fromKey` itself.
function reachableFrom(graph: ModelGraph, fromKey: string): Set<string> {
  const out = new Set([fromKey]);
  const queue = [fromKey];
  while (queue.length) {
    const k = queue.shift()!;
    for (const e of graph.edges) {
      if (stateKey(e.from) !== k) continue;
      const tk = stateKey(e.to);
      if (!out.has(tk)) {
        out.add(tk);
        queue.push(tk);
      }
    }
  }
  return out;
}

function evidenceFor(
  id: string,
  counterexample: Counterexample,
  dependencies: string[],
): Evidence {
  return {
    id,
    kind: "MODEL_COUNTEREXAMPLE",
    counterexample,
    replay: [],
    dependencies,
  };
}

function vacuousOrLimit(
  graph: ModelGraph,
  prop: Property,
): { verdict: "INCONCLUSIVE"; causes: Cause[] } {
  return {
    verdict: "INCONCLUSIVE",
    causes: graph.complete ? ["VACUOUS"] : ["EXPLORATION_LIMIT"],
  };
}

export function checkProperties(
  spec: UxSpec,
  graph: ModelGraph,
  context: RunContext,
): RunResults {
  const results: CheckResult[] = [];
  const diagnostics: Diagnostic[] = [];
  const evaluatedProperties: string[] = [];

  const stateList = graph.states;
  const fromCache = new Map<string, AbstractState[]>();

  for (const prop of spec.properties) {
    let fromStates = fromCache.get(prop.id);
    if (!fromStates) {
      fromStates = stateList.filter((s) => satisfies(prop.from, s));
      fromCache.set(prop.id, fromStates);
    }

    const finish = (
      verdict: CheckResult["verdict"],
      causes: Cause[],
      evidence: Evidence[] = [],
    ) => {
      evaluatedProperties.push(prop.id);
      results.push({
        target: "model",
        property: prop.id,
        verdict,
        causes,
        evidence,
      });
    };

    // vacuity / exploration-limit handling when no witness states exist
    if (fromStates.length === 0) {
      const r = vacuousOrLimit(graph, prop);
      finish(r.verdict, r.causes);
      continue;
    }

    switch (prop.kind) {
      case "neverTransition": {
        // violation: edge from `from`-state to `to`-state, event != unless
        let violation: { edge: ModelStep; fromState: AbstractState } | null = null;
        for (const e of graph.edges) {
          if (!satisfies(prop.from, e.from)) continue;
          if (!satisfies(prop.to!, e.to)) continue;
          if (prop.unless !== undefined && e.event === prop.unless) continue;
          violation = { edge: e, fromState: e.from };
          break; // edges are in deterministic BFS order → first = shortest-ish
        }
        if (violation) {
          const path = findPath(graph, stateKey(violation.fromState));
          const counterexample: Counterexample = {
            initial: graph.initial,
            events: [...(path?.events ?? []), violation.edge.event],
            modelSteps: [...(path?.steps ?? []), violation.edge],
            observations: [],
            minimized: false,
          };
          finish("CONFIRMED", [], [
            evidenceFor(`${prop.id}:counterexample`, counterexample, ["model"]),
          ]);
        } else if (!graph.complete) {
          // unexplored edges may hide a violation
          finish("INCONCLUSIVE", ["EXPLORATION_LIMIT"]);
        } else {
          finish("PASS", []);
        }
        break;
      }

      case "canReach": {
        // every from-state must reach some to-state (length-0 allowed)
        let undetermined = false;
        let counterFrom: AbstractState | null = null;
        for (const fs of fromStates) {
          const fk = stateKey(fs);
          if (satisfies(prop.to!, fs)) continue; // length-0 path
          const reach = reachableFrom(graph, fk);
          const ok = [...reach].some((k) => {
            const st = stateList.find((s) => stateKey(s) === k);
            return st !== undefined && satisfies(prop.to!, st);
          });
          if (ok) continue;
          if (!graph.complete) {
            undetermined = true;
            break;
          }
          counterFrom = fs;
          break;
        }
        if (counterFrom) {
          const fk = stateKey(counterFrom);
          const path = findPath(graph, fk);
          const explored = [...reachableFrom(graph, fk)].map((k) =>
            stateList.find((s) => stateKey(s) === k)!,
          );
          const counterexample: Counterexample = {
            initial: graph.initial,
            events: path?.events ?? [],
            modelSteps: path?.steps ?? [],
            observations: [],
            unreachableFrom: counterFrom,
            exploredFromWitness: explored,
            minimized: false,
          };
          finish("CONFIRMED", [], [
            evidenceFor(`${prop.id}:unreachable`, counterexample, ["model"]),
          ]);
        } else if (undetermined) {
          finish("INCONCLUSIVE", ["EXPLORATION_LIMIT"]);
        } else {
          finish("PASS", []);
        }
        break;
      }

      case "escapable": {
        // by=user → only user-kind events; by=any/undefined → all events
        const allowedEventIds =
          prop.by === "user"
            ? new Set(spec.events.filter((e) => e.kind === "user").map((e) => e.id))
            : null;
        let undetermined = false;
        let counterFrom: AbstractState | null = null;
        for (const fs of fromStates) {
          const fk = stateKey(fs);
          const reach = reachableFromKinds(graph, fk, allowedEventIds);
          // escape = reach a state outside `from`
          const escaped = [...reach].some((k) => {
            const st = stateList.find((s) => stateKey(s) === k);
            return st !== undefined && !satisfies(prop.from, st);
          });
          if (escaped) continue;
          if (!graph.complete) {
            undetermined = true;
            break;
          }
          counterFrom = fs;
          break;
        }
        if (counterFrom) {
          const fk = stateKey(counterFrom);
          const path = findPath(graph, fk);
          const counterexample: Counterexample = {
            initial: graph.initial,
            events: path?.events ?? [],
            modelSteps: path?.steps ?? [],
            observations: [],
            unreachableFrom: counterFrom,
            minimized: false,
          };
          finish("CONFIRMED", [], [
            evidenceFor(`${prop.id}:inescapable`, counterexample, ["model"]),
          ]);
        } else if (undetermined) {
          finish("INCONCLUSIVE", ["EXPLORATION_LIMIT"]);
        } else {
          finish("PASS", []);
        }
        break;
      }
    }
  }

  // surface deadlocks / unreachable events as diagnostics (info-level findings)
  for (const d of graph.deadlocks) {
    diagnostics.push({
      code: "MODEL_DEADLOCK",
      message: `デッドロック状態: ${stateKey(d)}`,
    });
  }
  for (const ev of graph.unreachableEvents) {
    diagnostics.push({
      code: "MODEL_UNREACHABLE_EVENT",
      message: `到達不能イベント: ${ev}`,
    });
  }
  for (const lim of graph.exhaustedLimits) {
    diagnostics.push({
      code: "MODEL_EXPLORATION_LIMIT",
      message: `探索上限に到達: ${lim}`,
    });
  }

  const coverage = [
    {
      target: "model" as const,
      states: stateList,
      transitions: [...new Set(graph.edges.map((e) => e.transition))],
      events: [...new Set(graph.edges.map((e) => e.event))].sort(),
      evaluatedProperties,
      missingObligations: graph.unexpanded.map((s) => `unexpanded:${stateKey(s)}`),
      complete: graph.complete,
    },
  ];

  return {
    context,
    results,
    coverage,
    diagnostics,
    notEvaluated: [],
  };
}

// reachableFrom restricted to a set of allowed event IDs (null = all events)
function reachableFromKinds(
  graph: ModelGraph,
  fromKey: string,
  allowedEventIds: Set<string> | null,
): Set<string> {
  const out = new Set([fromKey]);
  const queue = [fromKey];
  while (queue.length) {
    const k = queue.shift()!;
    for (const e of graph.edges) {
      if (stateKey(e.from) !== k) continue;
      if (allowedEventIds && !allowedEventIds.has(e.event)) continue;
      const tk = stateKey(e.to);
      if (!out.has(tk)) {
        out.add(tk);
        queue.push(tk);
      }
    }
  }
  return out;
}
