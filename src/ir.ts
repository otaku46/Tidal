// JSON IR types for Tidal (docs/spec_tidal.md FR-01〜FR-06).
// Mirrors design/core.toml schemas. All types are erasable-syntax safe.

export type Scalar = boolean | number | string;
export type JsonValue = any;

export type Target = "model" | "conformance" | "implementation";
export type Verdict = "PASS" | "CONFIRMED" | "INCONCLUSIVE" | "FLAKY" | "ERROR";
export type Cause =
  | "MODEL_DIVERGENCE"
  | "COVERAGE_SHORT"
  | "EXPLORATION_LIMIT"
  | "VACUOUS"
  | "UNEXPLAINED_CHANGE"
  | "ADAPTER_ERROR";
export type EvidenceKind =
  | "MODEL_COUNTEREXAMPLE"
  | "INDEPENDENT_ORACLE"
  | "OBSERVATION_MISMATCH";
export type EventKind = "user" | "browser" | "env";

export interface StateVariable {
  id: string;
  domain: Scalar[];
}

export interface StateValue {
  variable: string;
  value: Scalar;
}

export interface AbstractState {
  values: StateValue[];
}

export type Expression =
  | { op: "literal"; value: Scalar }
  | { op: "ref"; variable: string }
  | { op: "eq" | "ne" | "and" | "or"; args: [Expression, Expression] }
  | { op: "not"; args: [Expression] };

export interface Event {
  id: string;
  kind: "user" | "browser" | "env";
}

export type UpdateMap = Record<string, Expression>;

export interface Transition {
  id: string;
  event: string;
  when: Expression;
  set: UpdateMap;
}

export interface Property {
  id: string;
  kind: "neverTransition" | "canReach" | "escapable";
  from: Expression;
  to?: Expression;
  unless?: string;
  by?: GuardEventKind;
}

export interface AnalysisLimits {
  maxStates: number;
  maxDepth: number;
  maxTransitions: number;
}

export interface UxSpec {
  schemaVersion: string;
  kind: string;
  states: StateVariable[];
  initialState: AbstractState;
  events: Event[];
  transitions: Transition[];
  properties: Property[];
  analysis: AnalysisLimits;
}

export interface Diagnostic {
  code: string;
  message: string;
  path?: string;
  target?: Target;
}

// ---- model engine ----

export interface ModelStep {
  from: AbstractState;
  event: string;
  transition: string;
  to: AbstractState;
}

export interface ModelGraph {
  initial: AbstractState;
  states: AbstractState[];
  edges: ModelStep[];
  deadlocks: AbstractState[];
  unreachableEvents: string[];
  unexpanded: AbstractState[];
  exhaustedLimits: string[];
  complete: boolean;
}

// ---- reporting ----

export interface RunScope {
  targets?: Target[];
}

export type GuardEventKind = "user" | "any";

export interface DslDefinition {
  specification: UxSpec;
}

export interface FrameworkFixture {
  framework: "react" | "solid" | "svelte";
  binding: JsonValue; // resolved Binding JSON
}

export interface RunSelection {
  requested: RunScope;
  declared: Target[];
}

export interface RunContext {
  scope: RunScope;
  declaredTargets: Target[];
  effectiveTargets: Target[];
  analysis?: AnalysisLimits;
  seed?: string;
  environment?: any;
  reproduction?: any;
}

export interface Observation {
  state: AbstractState;
  provenance: "runner" | "app" | "unexplained";
  event?: string;
}

export interface Counterexample {
  initial?: AbstractState;
  events: string[];
  modelSteps: ModelStep[];
  observations: Observation[];
  unreachableFrom?: AbstractState;
  exploredFromWitness?: AbstractState[];
  expectedValue?: Scalar;
  actualValue?: Scalar;
  minimized: boolean;
}

export interface ReplayResult {
  attempt: number;
  outcome: "MATCH" | "MISMATCH" | "ERROR";
  expectedValue?: Scalar;
  actualValue?: Scalar;
  diagnostic?: Diagnostic;
}

export interface Evidence {
  id: string;
  kind: "MODEL_COUNTEREXAMPLE" | "INDEPENDENT_ORACLE" | "OBSERVATION_MISMATCH";
  counterexample: Counterexample;
  replay: ReplayResult[];
  dependencies: string[];
}

export interface CheckResult {
  target: Target;
  property: string;
  verdict: Verdict;
  causes: Cause[];
  evidence: Evidence[];
}

export interface NotEvaluated {
  target: Target;
  property?: string;
  reason: "NOT_REQUESTED" | "BLOCKED" | "INCOMPLETE";
  cause?: Cause;
}

export interface Coverage {
  target: Target;
  states: AbstractState[];
  transitions: string[];
  events: string[];
  evaluatedProperties: string[];
  missingObligations: string[];
  complete: boolean;
}

export interface RunResults {
  context: RunContext;
  results: CheckResult[];
  coverage: Coverage[];
  diagnostics: Diagnostic[];
  notEvaluated: NotEvaluated[];
}

export interface TargetResult {
  target: Target;
  verdict?: Verdict;
  properties: CheckResult[];
}

// ---- golden tests (design/golden.toml) ----

export interface GoldenExpectation {
  overall: Verdict;
  exitCode: number;
  target?: Target;
  cause?: Cause;
  evidenceKind?: string;
  requiredEvidenceFields: string[];
}

export interface GoldenCase {
  id: string;
  spec: JsonValue; // validated via validateSpec
  scope: RunScope;
  fixture?: string;
  expected: GoldenExpectation;
}

export interface Report {
  schemaVersion: string;
  context: RunContext;
  overall: Verdict;
  exitCode: number;
  targets: TargetResult[];
  confirmedViolations: CheckResult[];
  errors: Diagnostic[];
  notEvaluated: NotEvaluated[];
  coverage: Coverage[];
  evidence: Evidence[];
  counterexamples: Counterexample[];
  replayResults: ReplayResult[];
}
