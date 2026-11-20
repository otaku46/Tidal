import type {
  AbstractState,
  Diagnostic,
  Event,
  ModelGraph,
  ModelStep,
  Scalar,
  StateVariable,
  Transition,
  UxSpec,
} from "./ir.ts";
import { evaluateExpression, normalizeState, stateKey, varsById } from "./eval.ts";

function diag(code: string, message: string, path?: string): Diagnostic {
  return { code, message, path };
}

interface ExpandResult {
  steps: ModelStep[];
  diagnostics: Diagnostic[];
  enabledTransitionIds: string[];
}

// FR-04/FR-05: expand all enabled transitions from a state.
// user/browser: same event with overlapping guards leading to different
// results is a spec error; identical results are merged (ids kept for coverage).
// env: all candidate branches are kept.
export function expandState(spec: UxSpec, state: AbstractState): ExpandResult {
  const diagnostics: Diagnostic[] = [];
  const vars = varsById(spec);
  const eventKind = new Map(spec.events.map((e) => [e.id, e.kind]));

  // event id -> resultKey -> { to, transitionIds }
  const byEvent = new Map<
    string,
    Map<string, { to: AbstractState; transitionIds: string[] }>
  >();
  const enabledTransitionIds: string[] = [];

  const sortedTransitions = [...spec.transitions].sort((a, b) =>
    a.event === b.event ? (a.id < b.id ? -1 : 1) : a.event < b.event ? -1 : 1,
  );

  for (const t of sortedTransitions) {
    const w = evaluateExpression(t.when, state);
    if (w.diagnostic) {
      diagnostics.push({ ...w.diagnostic, path: `transitions.${t.id}.when` });
      continue;
    }
    if (w.value !== true) continue;
    enabledTransitionIds.push(t.id);

    // evaluate all updates against the pre-state, apply simultaneously
    const next = new Map(state.values.map((v) => [v.variable, v.value]));
    let ok = true;
    for (const [varId, expr] of Object.entries(t.set)) {
      const r = evaluateExpression(expr, state);
      if (r.diagnostic) {
        diagnostics.push({ ...r.diagnostic, path: `transitions.${t.id}.set.${varId}` });
        ok = false;
        break;
      }
      next.set(varId, r.value as Scalar);
    }
    if (!ok) continue;

    // domain check
    for (const [varId, value] of next) {
      const v: StateVariable | undefined = vars.get(varId);
      if (v && !v.domain.includes(value)) {
        diagnostics.push(
          diag(
            "SPEC_DOMAIN_RANGE",
            `遷移 ${t.id} の更新値 ${JSON.stringify(value)} は ${varId} の値域外です`,
          ),
        );
        ok = false;
      }
    }
    if (!ok) continue;

    const to = normalizeState({
      values: [...next.entries()].map(([variable, value]) => ({ variable, value })),
    });
    const key = stateKey(to);
    let results = byEvent.get(t.event);
    if (!results) {
      results = new Map();
      byEvent.set(t.event, results);
    }
    const existing = results.get(key);
    if (existing) {
      existing.transitionIds.push(t.id);
    } else {
      results.set(key, { to, transitionIds: [t.id] });
    }
  }

  const steps: ModelStep[] = [];
  const sortedEvents = [...byEvent.keys()].sort();
  for (const eventId of sortedEvents) {
    const kind = eventKind.get(eventId);
    const results = [...byEvent.get(eventId)!.values()];
    if ((kind === "user" || kind === "browser") && results.length > 1) {
      diagnostics.push(
        diag(
          "SPEC_AMBIGUOUS_GUARD",
          `状態 ${stateKey(state)} でイベント ${eventId} (${kind}) のガードが重複し、異なる遷移先が ${results.length} 件あります`,
        ),
      );
      continue;
    }
    // deterministic order: by resulting state key
    results.sort((a, b) => (stateKey(a.to) < stateKey(b.to) ? -1 : 1));
    for (const r of results) {
      steps.push({
        from: state,
        event: eventId,
        transition: r.transitionIds[0],
        to: r.to,
      });
    }
  }

  return { steps, diagnostics, enabledTransitionIds };
}

interface ParentLink {
  prevKey: string;
  step: ModelStep;
}

// Deterministic BFS over the reachable state space (Q2: breadth-first).
export function exploreModel(spec: UxSpec): {
  graph: ModelGraph;
  diagnostics: Diagnostic[];
  parents: Map<string, ParentLink>;
  transitionIds: Set<string>;
  eventEnabled: Set<string>;
} {
  const diagnostics: Diagnostic[] = [];
  const initial = normalizeState(spec.initialState);
  const initialKey = stateKey(initial);

  const states: AbstractState[] = [];
  const stateIndex = new Map<string, number>();
  const edges: ModelStep[] = [];
  const parents = new Map<string, ParentLink>();
  const transitionIds = new Set<string>();
  const eventEnabled = new Set<string>();
  const expanded = new Set<string>();
  const unexpanded: AbstractState[] = [];
  const exhaustedLimits: string[] = [];

  const queue: { state: AbstractState; key: string; depth: number }[] = [
    { state: initial, key: initialKey, depth: 0 },
  ];
  states.push(initial);
  stateIndex.set(initialKey, 0);

  let transitionCount = 0;
  const limitHit = new Set<string>();

  while (queue.length > 0) {
    const { state, key, depth } = queue.shift()!;

    // limits checked before expansion; the state itself is already counted
    if (
      states.length > spec.analysis.maxStates ||
      depth > spec.analysis.maxDepth ||
      transitionCount >= spec.analysis.maxTransitions
    ) {
      if (!expanded.has(key)) {
        unexpanded.push(state);
        if (depth > spec.analysis.maxDepth && !limitHit.has("maxDepth")) {
          limitHit.add("maxDepth");
          exhaustedLimits.push("maxDepth");
        }
        if (states.length > spec.analysis.maxStates && !limitHit.has("maxStates")) {
          limitHit.add("maxStates");
          exhaustedLimits.push("maxStates");
        }
        if (transitionCount >= spec.analysis.maxTransitions && !limitHit.has("maxTransitions")) {
          limitHit.add("maxTransitions");
          exhaustedLimits.push("maxTransitions");
        }
      }
      continue;
    }

    expanded.add(key);
    const { steps, diagnostics: stepDiags, enabledTransitionIds } = expandState(spec, state);
    diagnostics.push(...stepDiags);
    for (const id of enabledTransitionIds) transitionIds.add(id);
    for (const s of steps) eventEnabled.add(s.event);

    // edges sorted deterministically: event id, then transition id, then target key
    const sorted = [...steps].sort((a, b) =>
      a.event === b.event
        ? a.transition === b.transition
          ? stateKey(a.to) < stateKey(b.to)
            ? -1
            : 1
          : a.transition < b.transition
            ? -1
            : 1
        : a.event < b.event
          ? -1
          : 1,
    );

    for (const step of sorted) {
      edges.push(step);
      transitionCount += 1;
      const toKey = stateKey(step.to);
      if (!stateIndex.has(toKey)) {
        if (states.length >= spec.analysis.maxStates) {
          // cannot record the state; edge still recorded, target marked via unexpanded
          if (!unexpanded.some((s) => stateKey(s) === toKey)) {
            unexpanded.push(step.to);
          }
          if (!limitHit.has("maxStates")) {
            limitHit.add("maxStates");
            exhaustedLimits.push("maxStates");
          }
          continue;
        }
        stateIndex.set(toKey, states.length);
        states.push(step.to);
        parents.set(toKey, { prevKey: key, step });
        if (depth + 1 <= spec.analysis.maxDepth) {
          queue.push({ state: step.to, key: toKey, depth: depth + 1 });
        } else {
          unexpanded.push(step.to);
          if (!limitHit.has("maxDepth")) {
            limitHit.add("maxDepth");
            exhaustedLimits.push("maxDepth");
          }
        }
      } else {
        // known state: edge recorded; ensure it gets expanded if queued already
      }
    }
  }

  // deadlocks: fully expanded states with zero enabled events
  const deadlocks: AbstractState[] = [];
  for (const s of states) {
    const k = stateKey(s);
    if (expanded.has(k) && !edges.some((e) => stateKey(e.from) === k)) {
      deadlocks.push(s);
    }
  }

  const complete = unexpanded.length === 0;

  const unreachableEvents =
    complete && diagnostics.length === 0
      ? spec.events.map((e) => e.id).filter((id) => !eventEnabled.has(id))
      : [];

  const graph: ModelGraph = {
    initial,
    states,
    edges,
    deadlocks,
    unreachableEvents,
    unexpanded,
    exhaustedLimits,
    complete,
  };

  return { graph, diagnostics, parents, transitionIds, eventEnabled };
}
