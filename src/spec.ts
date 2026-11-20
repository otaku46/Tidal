import type {
  AbstractState,
  AnalysisLimits,
  Diagnostic,
  EventKind,
  Expression,
  Property,
  Scalar,
  StateVariable,
  Transition,
  UxSpec,
} from "./ir.ts";

export const SPEC_KIND = "tidal.uxSpec";
export const SPEC_SCHEMA_VERSION = "0.1.0";

const SUPPORTED_VERSIONS = new Set([SPEC_SCHEMA_VERSION]);
const EVENT_KINDS = new Set<EventKind>(["user", "browser", "env"]);
const PROPERTY_KINDS = new Set(["neverTransition", "canReach", "escapable"]);
const GUARD_KINDS = new Set(["user", "any"]);
const EXPRESSION_OPS = new Set(["literal", "ref", "eq", "ne", "and", "or", "not"]);

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isScalar(v: unknown): v is Scalar {
  return (
    typeof v === "boolean" ||
    (typeof v === "number" && Number.isSafeInteger(v)) ||
    typeof v === "string"
  );
}

function diag(code: string, message: string, path?: string): Diagnostic {
  return { code, message, path };
}

function typeOf(v: Scalar): "bool" | "int" | "string" {
  if (typeof v === "boolean") return "bool";
  if (typeof v === "number") return "int";
  return "string";
}

// ---- expression validation ----

function validateExpression(
  node: unknown,
  path: string,
  vars: Map<string, StateVariable>,
  diags: Diagnostic[],
): Expression | null {
  if (!isObj(node) || typeof node.op !== "string" || !EXPRESSION_OPS.has(node.op)) {
    diags.push(diag("EXPR_INVALID", `式の op が不正です: ${JSON.stringify(node)}`, path));
    return null;
  }
  const op = node.op as Expression["op"];
  switch (op) {
    case "literal":
      if (!("value" in node) || !isScalar(node.value)) {
        diags.push(diag("EXPR_INVALID", "literal 式に有効な value がありません", path));
        return null;
      }
      return { op, value: node.value as Scalar };
    case "ref": {
      if (typeof node.variable !== "string" || !vars.has(node.variable)) {
        diags.push(
          diag("EXPR_UNDEFINED_REF", `未定義の状態変数参照: ${String(node.variable)}`, path),
        );
        return null;
      }
      return { op, variable: node.variable };
    }
    case "not": {
      const args = node.args;
      if (!Array.isArray(args) || args.length !== 1) {
        diags.push(diag("EXPR_ARITY", "not は引数1個を取ります", path));
        return null;
      }
      const inner = validateExpression(args[0], `${path}.args[0]`, vars, diags);
      if (inner && expressionType(inner, vars) !== "bool") {
        diags.push(diag("EXPR_TYPE", "not の引数は bool である必要があります", path));
        return null;
      }
      return inner ? { op, args: [inner] } : null;
    }
    case "and":
    case "or":
    case "eq":
    case "ne": {
      const args = node.args;
      if (!Array.isArray(args) || args.length !== 2) {
        diags.push(diag("EXPR_ARITY", `${op} は引数2個を取ります`, path));
        return null;
      }
      const left = validateExpression(args[0], `${path}.args[0]`, vars, diags);
      const right = validateExpression(args[1], `${path}.args[1]`, vars, diags);
      if (!left || !right) return null;
      const lt = expressionType(left, vars);
      const rt = expressionType(right, vars);
      if (op === "and" || op === "or") {
        if (lt !== "bool" || rt !== "bool") {
          diags.push(diag("EXPR_TYPE", `${op} の引数は bool である必要があります`, path));
          return null;
        }
      } else if (lt !== rt) {
        diags.push(
          diag("EXPR_TYPE", `${op} の被演算子の型が一致しません (${lt} vs ${rt})`, path),
        );
        return null;
      }
      return { op, args: [left, right] } as Expression;
    }
  }
  return null;
}

// Static type of an expression: 'bool' for predicates, else the scalar type.
export function expressionType(
  expr: Expression,
  vars: Map<string, StateVariable>,
): "bool" | "int" | "string" | "unknown" {
  switch (expr.op) {
    case "literal":
      return expr.op === "literal" && expr.value !== undefined ? typeOf(expr.value) : "unknown";
    case "ref": {
      const v = expr.variable === undefined ? undefined : vars.get(expr.variable);
      if (!v) return "unknown";
      // domain is single-type per validateSpec; derive from first element
      return v.domain.length > 0 ? typeOf(v.domain[0]) : "unknown";
    }
    case "not":
    case "and":
    case "or":
      return "bool";
    case "eq":
    case "ne":
      return "bool";
  }
}

// ---- spec validation ----

export function validateSpec(input: unknown): { spec?: UxSpec; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  if (!isObj(input)) {
    return { diagnostics: [diag("SPEC_NOT_OBJECT", "spec は JSON オブジェクトである必要があります")] };
  }
  if (input.kind !== SPEC_KIND) {
    diagnostics.push(diag("SPEC_KIND", `kind は '${SPEC_KIND}' である必要があります`));
  }
  if (typeof input.schemaVersion !== "string" || !SUPPORTED_VERSIONS.has(input.schemaVersion)) {
    diagnostics.push(
      diag(
        "SPEC_VERSION",
        `未対応の schemaVersion: ${String(input.schemaVersion)} (対応: ${[...SUPPORTED_VERSIONS].join(", ")})`,
      ),
    );
  }

  // states
  const vars = new Map<string, StateVariable>();
  if (!Array.isArray(input.states) || input.states.length === 0) {
    diagnostics.push(diag("SPEC_STATES", "states は1個以上の配列である必要があります"));
  } else {
    for (const [i, s] of input.states.entries()) {
      const p = `states[${i}]`;
      if (!isObj(s) || typeof s.id !== "string" || !Array.isArray(s.domain)) {
        diagnostics.push(diag("SPEC_STATES", "state には id と domain が必要です", p));
        continue;
      }
      if (vars.has(s.id)) {
        diagnostics.push(diag("SPEC_DUP_ID", `状態変数 ID が重複: ${s.id}`, p));
        continue;
      }
      if (s.domain.length === 0 || !s.domain.every(isScalar)) {
        diagnostics.push(diag("SPEC_DOMAIN", "domain は空でないスカラー列である必要があります", p));
        continue;
      }
      const types = new Set(s.domain.map(typeOf));
      if (types.size !== 1) {
        diagnostics.push(diag("SPEC_DOMAIN_TYPE", "domain は単一の型である必要があります", p));
        continue;
      }
      if (new Set(s.domain).size !== s.domain.length) {
        diagnostics.push(diag("SPEC_DOMAIN_DUP", "domain に重複する値があります", p));
      }
      vars.set(s.id, { id: s.id, domain: s.domain as Scalar[] });
    }
  }

  // initialState
  const initialValues = new Map<string, Scalar>();
  if (!isObj(input.initialState) || !Array.isArray(input.initialState.values)) {
    diagnostics.push(diag("SPEC_INIT", "initialState.values が必要です"));
  } else {
    for (const [i, sv] of input.initialState.values.entries()) {
      const p = `initialState.values[${i}]`;
      if (!isObj(sv) || typeof sv.variable !== "string" || !isScalar(sv.value)) {
        diagnostics.push(diag("SPEC_INIT", "StateValue には variable と value が必要です", p));
        continue;
      }
      const v = vars.get(sv.variable);
      if (!v) {
        diagnostics.push(diag("SPEC_INIT_REF", `未定義変数への初期値: ${sv.variable}`, p));
        continue;
      }
      if (!v.domain.includes(sv.value)) {
        diagnostics.push(
          diag("SPEC_INIT_DOMAIN", `初期値 ${JSON.stringify(sv.value)} は ${sv.variable} の値域外です`, p),
        );
        continue;
      }
      if (initialValues.has(sv.variable)) {
        diagnostics.push(diag("SPEC_INIT_DUP", `初期値が重複: ${sv.variable}`, p));
      }
      initialValues.set(sv.variable, sv.value);
    }
    for (const id of vars.keys()) {
      if (!initialValues.has(id)) {
        diagnostics.push(diag("SPEC_INIT_MISSING", `初期値がありません: ${id}`));
      }
    }
  }

  // events
  const events = new Map<string, { id: string; kind: EventKind }>();
  if (!Array.isArray(input.events)) {
    diagnostics.push(diag("SPEC_EVENTS", "events は配列である必要があります"));
  } else {
    for (const [i, e] of input.events.entries()) {
      const p = `events[${i}]`;
      if (!isObj(e) || typeof e.id !== "string" || typeof e.kind !== "string" || !EVENT_KINDS.has(e.kind as EventKind)) {
        diagnostics.push(diag("SPEC_EVENTS", "event には id と kind (user|browser|env) が必要です", p));
        continue;
      }
      if (events.has(e.id)) {
        diagnostics.push(diag("SPEC_DUP_ID", `イベント ID が重複: ${e.id}`, p));
        continue;
      }
      events.set(e.id, { id: e.id, kind: e.kind as EventKind });
    }
  }

  // transitions
  const transitions: Transition[] = [];
  const transitionIds = new Set<string>();
  if (!Array.isArray(input.transitions)) {
    diagnostics.push(diag("SPEC_TRANSITIONS", "transitions は配列である必要があります"));
  } else {
    for (const [i, t] of input.transitions.entries()) {
      const p = `transitions[${i}]`;
      if (!isObj(t) || typeof t.id !== "string" || typeof t.event !== "string") {
        diagnostics.push(diag("SPEC_TRANSITIONS", "transition には id と event が必要です", p));
        continue;
      }
      if (transitionIds.has(t.id)) {
        diagnostics.push(diag("SPEC_DUP_ID", `遷移 ID が重複: ${t.id}`, p));
        continue;
      }
      transitionIds.add(t.id);
      const ev = events.get(t.event);
      if (!ev) {
        diagnostics.push(diag("SPEC_TRANS_EVENT", `未定義イベントへの遷移: ${t.event}`, p));
        continue;
      }
      const when = validateExpression(t.when, `${p}.when`, vars, diagnostics);
      if (!when || expressionType(when, vars) !== "bool") {
        if (when) diagnostics.push(diag("EXPR_TYPE", "when は bool 式である必要があります", `${p}.when`));
        continue;
      }
      const set: Transition["set"] = {};
      let setOk = true;
      if (!isObj(t.set)) {
        diagnostics.push(diag("SPEC_SET", "set はオブジェクトである必要があります", `${p}.set`));
        setOk = false;
      } else {
        for (const [varId, exprNode] of Object.entries(t.set)) {
          if (!vars.has(varId)) {
            diagnostics.push(diag("SPEC_SET_REF", `未定義変数への更新: ${varId}`, `${p}.set`));
            setOk = false;
            continue;
          }
          const expr = validateExpression(exprNode, `${p}.set.${varId}`, vars, diagnostics);
          if (!expr) {
            setOk = false;
            continue;
          }
          const et = expressionType(expr, vars);
          const vt = vars.get(varId)!.domain.length > 0 ? typeOf(vars.get(varId)!.domain[0]) : "unknown";
          if (et !== vt && et !== "unknown") {
            diagnostics.push(
              diag("EXPR_TYPE", `更新値の型が変数 ${varId} と一致しません (${et} vs ${vt})`, `${p}.set.${varId}`),
            );
            setOk = false;
            continue;
          }
          set[varId] = expr;
        }
      }
      if (setOk) transitions.push({ id: t.id, event: t.event, when, set });
    }
  }

  // properties
  const properties: Property[] = [];
  const propertyIds = new Set<string>();
  if (!Array.isArray(input.properties)) {
    diagnostics.push(diag("SPEC_PROPERTIES", "properties は配列である必要があります"));
  } else {
    for (const [i, pr] of input.properties.entries()) {
      const p = `properties[${i}]`;
      if (!isObj(pr) || typeof pr.id !== "string" || typeof pr.kind !== "string" || !PROPERTY_KINDS.has(pr.kind)) {
        diagnostics.push(diag("SPEC_PROPERTIES", "property には id と kind が必要です", p));
        continue;
      }
      if (propertyIds.has(pr.id)) {
        diagnostics.push(diag("SPEC_DUP_ID", `プロパティ ID が重複: ${pr.id}`, p));
        continue;
      }
      propertyIds.add(pr.id);
      const kind = pr.kind as Property["kind"];
      const from = validateExpression(pr.from, `${p}.from`, vars, diagnostics);
      if (!from || expressionType(from, vars) !== "bool") {
        if (from) diagnostics.push(diag("EXPR_TYPE", "from は bool 式である必要があります", `${p}.from`));
        continue;
      }
      const prop: Property = { id: pr.id, kind, from };
      if (kind === "neverTransition") {
        const to = validateExpression(pr.to, `${p}.to`, vars, diagnostics);
        if (!to || expressionType(to, vars) !== "bool") {
          if (to) diagnostics.push(diag("EXPR_TYPE", "to は bool 式である必要があります", `${p}.to`));
          continue;
        }
        prop.to = to;
        if (pr.unless !== undefined) {
          if (typeof pr.unless !== "string" || !events.has(pr.unless)) {
            diagnostics.push(diag("SPEC_PROP_REF", `unless は既知のイベント ID である必要があります: ${String(pr.unless)}`, p));
            continue;
          }
          prop.unless = pr.unless;
        }
      } else if (kind === "canReach") {
        const to = validateExpression(pr.to, `${p}.to`, vars, diagnostics);
        if (!to || expressionType(to, vars) !== "bool") {
          if (to) diagnostics.push(diag("EXPR_TYPE", "to は bool 式である必要があります", `${p}.to`));
          continue;
        }
        prop.to = to;
      } else {
        // escapable
        if (pr.by !== undefined) {
          if (typeof pr.by !== "string" || !GUARD_KINDS.has(pr.by)) {
            diagnostics.push(diag("SPEC_PROP_REF", `by は user|any である必要があります: ${String(pr.by)}`, p));
            continue;
          }
          prop.by = pr.by as "user" | "any";
        }
      }
      properties.push(prop);
    }
  }

  // analysis
  let analysis: AnalysisLimits | undefined;
  if (!isObj(input.analysis)) {
    diagnostics.push(diag("SPEC_ANALYSIS", "analysis が必要です"));
  } else {
    const { maxStates, maxDepth, maxTransitions } = input.analysis;
    const okInt = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v);
    if (!okInt(maxStates) || (maxStates as number) < 1) {
      diagnostics.push(diag("SPEC_ANALYSIS", "maxStates は1以上の安全整数である必要があります"));
    }
    if (!okInt(maxDepth) || (maxDepth as number) < 0) {
      diagnostics.push(diag("SPEC_ANALYSIS", "maxDepth は0以上の安全整数である必要があります"));
    }
    if (!okInt(maxTransitions) || (maxTransitions as number) < 0) {
      diagnostics.push(diag("SPEC_ANALYSIS", "maxTransitions は0以上の安全整数である必要があります"));
    }
    if (diagnostics.length === 0 || okInt(maxStates) && okInt(maxDepth) && okInt(maxTransitions)) {
      analysis = {
        maxStates: maxStates as number,
        maxDepth: maxDepth as number,
        maxTransitions: maxTransitions as number,
      };
    }
  }

  if (diagnostics.length > 0) return { diagnostics };

  const spec: UxSpec = {
    schemaVersion: input.schemaVersion as string,
    kind: SPEC_KIND,
    states: [...vars.values()],
    initialState: {
      values: [...vars.keys()].map((id) => ({ variable: id, value: initialValues.get(id)! })),
    },
    events: [...events.values()],
    transitions,
    properties,
    analysis: analysis!,
  };
  return { spec, diagnostics };
}
