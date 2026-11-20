import type {
  AbstractState,
  AnalysisLimits,
  Event,
  Expression,
  Property,
  Scalar,
  StateVariable,
  Transition,
  UxSpec,
} from "./ir.ts";
import { SPEC_KIND, SPEC_SCHEMA_VERSION } from "./spec.ts";

// func.compileSpec: TypeScript DSL → versioned JSON IR (FR-01).
// Expression combinators build the tagged expression tree; nothing executable
// is embedded in the IR (FR-03).

export const literal = (value: Scalar): Expression => ({ op: "literal", value });
export const ref = (variable: string): Expression => ({ op: "ref", variable });
export const eq = (a: Expression, b: Expression): Expression => ({ op: "eq", args: [a, b] });
export const ne = (a: Expression, b: Expression): Expression => ({ op: "ne", args: [a, b] });
export const and = (a: Expression, b: Expression): Expression => ({ op: "and", args: [a, b] });
export const or = (a: Expression, b: Expression): Expression => ({ op: "or", args: [a, b] });
export const not = (a: Expression): Expression => ({ op: "not", args: [a] });

export const bool = (v: boolean): Expression => literal(v);

export interface DslTransition {
  id: string;
  event: string;
  when?: Expression; // default: literal(true)
  set?: Record<string, Expression>; // default: {} (enabled, no abstract change)
}

export interface DslProperty {
  id: string;
  kind: "neverTransition" | "canReach" | "escapable";
  from: Expression;
  to?: Expression;
  unless?: string;
  by?: "user" | "any";
}

export interface DslSpec {
  states: StateVariable[];
  initialState: AbstractState;
  events: Event[];
  transitions: DslTransition[];
  properties: DslProperty[];
  analysis: AnalysisLimits;
}

export function defineSpec(dsl: DslSpec): UxSpec {
  return {
    schemaVersion: SPEC_SCHEMA_VERSION,
    kind: SPEC_KIND,
    states: dsl.states,
    initialState: dsl.initialState,
    events: dsl.events,
    transitions: dsl.transitions.map((t) => ({
      id: t.id,
      event: t.event,
      when: t.when ?? { op: "literal", value: true },
      set: t.set ?? {},
    })),
    properties: dsl.properties.map((p) => {
      const out: Property = { id: p.id, kind: p.kind, from: p.from };
      if (p.to !== undefined) out.to = p.to;
      if (p.unless !== undefined) out.unless = p.unless;
      if (p.by !== undefined) out.by = p.by;
      return out;
    }),
    analysis: dsl.analysis,
  };
}

// compileSpec input is DslDefinition { specification: UxSpec };
// output is the versioned JSON IR value.
export function compileSpec(definition: { specification: UxSpec }): Record<string, unknown> {
  return JSON.parse(JSON.stringify(definition.specification)) as Record<string, unknown>;
}
