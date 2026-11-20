import type {
  AbstractState,
  Diagnostic,
  Expression,
  Scalar,
  StateVariable,
} from "./ir.ts";

function diag(code: string, message: string): Diagnostic {
  return { code, message };
}

export function stateValue(state: AbstractState, variable: string): Scalar | undefined {
  return state.values.find((v) => v.variable === variable)?.value;
}

export function varsById(spec: { states: StateVariable[] }): Map<string, StateVariable> {
  return new Map(spec.states.map((s) => [s.id, s]));
}

// Deterministic canonical key: variables sorted by id.
export function stateKey(state: AbstractState): string {
  return [...state.values]
    .sort((a, b) => (a.variable < b.variable ? -1 : a.variable > b.variable ? 1 : 0))
    .map((v) => `${v.variable}=${JSON.stringify(v.value)}`)
    .join("|");
}

export function normalizeState(state: AbstractState): AbstractState {
  return {
    values: [...state.values].sort((a, b) =>
      a.variable < b.variable ? -1 : a.variable > b.variable ? 1 : 0,
    ),
  };
}

export function evaluateExpression(
  expr: Expression,
  state: AbstractState,
): { value?: Scalar; diagnostic?: Diagnostic } {
  switch (expr.op) {
    case "literal":
      if (expr.value === undefined) {
        return { diagnostic: diag("EXPR_INVALID", "literal 式に value がありません") };
      }
      return { value: expr.value };
    case "ref": {
      if (expr.variable === undefined) {
        return { diagnostic: diag("EXPR_INVALID", "ref 式に variable がありません") };
      }
      const v = stateValue(state, expr.variable);
      if (v === undefined) {
        return {
          diagnostic: diag(
            "EXPR_UNDEFINED_REF",
            `状態に変数 ${expr.variable} が存在しません`,
          ),
        };
      }
      return { value: v };
    }
    case "not": {
      const r = evaluateExpression(expr.args![0], state);
      if (r.diagnostic) return { diagnostic: r.diagnostic };
      if (typeof r.value !== "boolean") {
        return { diagnostic: diag("EXPR_TYPE", "not の引数は bool である必要があります") };
      }
      return { value: !r.value };
    }
    case "and": {
      const l = evaluateExpression(expr.args![0], state);
      if (l.diagnostic) return { diagnostic: l.diagnostic };
      if (l.value !== true) {
        if (typeof l.value !== "boolean") {
          return { diagnostic: diag("EXPR_TYPE", "and の引数は bool である必要があります") };
        }
        return { value: false };
      }
      const r = evaluateExpression(expr.args![1], state);
      if (r.diagnostic) return { diagnostic: r.diagnostic };
      if (typeof r.value !== "boolean") {
        return { diagnostic: diag("EXPR_TYPE", "and の引数は bool である必要があります") };
      }
      return { value: r.value };
    }
    case "or": {
      const l = evaluateExpression(expr.args![0], state);
      if (l.diagnostic) return { diagnostic: l.diagnostic };
      if (typeof l.value !== "boolean") {
        return { diagnostic: diag("EXPR_TYPE", "or の引数は bool である必要があります") };
      }
      if (l.value === true) return { value: true };
      const r = evaluateExpression(expr.args![1], state);
      if (r.diagnostic) return { diagnostic: r.diagnostic };
      if (typeof r.value !== "boolean") {
        return { diagnostic: diag("EXPR_TYPE", "or の引数は bool である必要があります") };
      }
      return { value: r.value };
    }
    case "eq":
    case "ne": {
      const l = evaluateExpression(expr.args![0], state);
      if (l.diagnostic) return { diagnostic: l.diagnostic };
      const r = evaluateExpression(expr.args![1], state);
      if (r.diagnostic) return { diagnostic: r.diagnostic };
      if (typeof l.value !== typeof r.value) {
        return { diagnostic: diag("EXPR_TYPE", `${expr.op} の被演算子の型が一致しません`) };
      }
      const eq = l.value === r.value;
      return { value: expr.op === "eq" ? eq : !eq };
    }
  }
}
