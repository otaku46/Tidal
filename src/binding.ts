import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type {
  AbstractState,
  Diagnostic,
  Scalar,
  UxSpec,
} from "./ir.ts";

export const BINDING_SCHEMA_VERSION = "0.1.0";

export interface Locator {
  kind: "role" | "ariaLabel" | "testId";
  value: string;
  name?: string;
}

export interface Read {
  locator: Locator;
  kind: "attribute" | "text" | "value";
  attribute?: string;
}

export interface Action {
  kind: "navigate" | "click" | "fill" | "reload" | "back" | "wait";
  locator?: Locator;
  path?: string;
  value?: string;
  inputId?: string;
  condition?: Read;
  expected?: Scalar;
}

export interface ObservationCase {
  observed: Scalar;
  abstract: Scalar;
}

export interface ObservationRule {
  variable: string;
  source: Read;
  cases: ObservationCase[];
}

export interface BoundEvent {
  event: string;
  actions: Action[];
  appMarker?: Read;
  networkFixture?: string;
}

export interface ConcreteInput {
  id: string;
  value: string;
}

export interface OracleRule {
  property: string;
  inputId: string;
  afterEvent: string;
  actual: Read;
}

export interface NetworkFixture {
  id: string;
  path: string;
  status: number;
  body?: string;
}

export interface Binding {
  schemaVersion: string;
  baseUrl: string;
  events: BoundEvent[];
  observe: ObservationRule[];
  oracles: OracleRule[];
  setup: Action[];
  reset: Action[];
  network: NetworkFixture[];
  selfTest: Read[];
}

export interface RuntimeConfig {
  allowedOrigins: string[];
  timeoutMs: number;
  replayAttempts: number;
  seed: string;
  // 反例トレース最小化の試行上限（FR-26/Q8）。未指定時は runtime 側の既定値。
  minimizeAttempts?: number;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// binding ファイルの読み込み。"extends" で親ファイルを継承できる。
// マージはトップレベルの浅い上書きで、子のキーが優先される（配列は子が丸ごと置き換える）。
// extends パスは記述ファイルからの相対パス。循環参照はエラー。
export function loadBindingJson(path: string, seen: string[] = []): unknown {
  const abs = resolve(path);
  if (seen.includes(abs)) {
    throw new Error(`binding extends が循環しています: ${abs}`);
  }
  const raw = JSON.parse(readFileSync(abs, "utf8")) as unknown;
  if (!isObj(raw) || typeof raw.extends !== "string") return raw;
  const parent = loadBindingJson(resolve(dirname(abs), raw.extends), [...seen, abs]);
  if (!isObj(parent)) {
    throw new Error(`extends 先がオブジェクトではありません: ${raw.extends}`);
  }
  const { extends: _drop, ...child } = raw;
  return { ...parent, ...child };
}

function diag(code: string, message: string, path?: string): Diagnostic {
  return { code, message, path };
}

function checkLocator(v: unknown, path: string, diags: Diagnostic[]): Locator | null {
  if (!isObj(v) || typeof v.value !== "string") {
    diags.push(diag("BINDING_LOCATOR", "locator には value が必要です", path));
    return null;
  }
  if (v.kind !== "role" && v.kind !== "ariaLabel" && v.kind !== "testId") {
    diags.push(diag("BINDING_LOCATOR", "locator.kind は role|ariaLabel|testId", path));
    return null;
  }
  const out: Locator = { kind: v.kind, value: v.value };
  if (typeof v.name === "string") out.name = v.name;
  return out;
}

function checkRead(v: unknown, path: string, diags: Diagnostic[]): Read | null {
  if (!isObj(v)) {
    diags.push(diag("BINDING_READ", "read が不正です", path));
    return null;
  }
  const locator = checkLocator(v.locator, `${path}.locator`, diags);
  if (!locator) return null;
  if (v.kind !== "attribute" && v.kind !== "text" && v.kind !== "value") {
    diags.push(diag("BINDING_READ", "read.kind は attribute|text|value", path));
    return null;
  }
  const out: Read = { locator, kind: v.kind };
  if (typeof v.attribute === "string") out.attribute = v.attribute;
  return out;
}

const ACTION_KINDS = new Set(["navigate", "click", "fill", "reload", "back", "wait"]);

function checkAction(v: unknown, path: string, diags: Diagnostic[]): Action | null {
  if (!isObj(v) || typeof v.kind !== "string" || !ACTION_KINDS.has(v.kind)) {
    diags.push(diag("BINDING_ACTION", "action.kind が不正です", path));
    return null;
  }
  const out: Action = { kind: v.kind as Action["kind"] };
  if (v.locator !== undefined) {
    const l = checkLocator(v.locator, `${path}.locator`, diags);
    if (l) out.locator = l;
  }
  if (typeof v.path === "string") out.path = v.path;
  if (typeof v.value === "string") out.value = v.value;
  if (typeof v.inputId === "string") out.inputId = v.inputId;
  if (v.condition !== undefined) {
    const c = checkRead(v.condition, `${path}.condition`, diags);
    if (c) out.condition = c;
  }
  if (v.expected !== undefined) {
    if (typeof v.expected !== "boolean" && typeof v.expected !== "string" &&
        !(typeof v.expected === "number" && Number.isSafeInteger(v.expected))) {
      diags.push(diag("BINDING_ACTION", "expected はスカラーである必要があります", path));
      return null;
    }
    out.expected = v.expected as Scalar;
  }
  return out;
}

// func.resolveBinding: binding.json 構造・参照・許可 origin の検証 (FR-13)
export function resolveBinding(
  input: unknown,
  spec: UxSpec,
  config: RuntimeConfig,
): { binding?: Binding; diagnostics: Diagnostic[] } {
  const diags: Diagnostic[] = [];
  if (!isObj(input)) {
    return { diagnostics: [diag("BINDING_NOT_OBJECT", "binding は JSON オブジェクトである必要があります")] };
  }
  if (input.schemaVersion !== BINDING_SCHEMA_VERSION) {
    diags.push(diag("BINDING_VERSION", `未対応の schemaVersion: ${String(input.schemaVersion)}`));
  }
  if (typeof input.baseUrl !== "string") {
    diags.push(diag("BINDING_BASEURL", "baseUrl が必要です"));
  } else {
    let origin: string;
    try {
      origin = new URL(input.baseUrl).origin;
    } catch {
      diags.push(diag("BINDING_BASEURL", `baseUrl が URL ではありません: ${input.baseUrl}`));
      origin = "";
    }
    if (origin && !config.allowedOrigins.includes(origin)) {
      diags.push(
        diag("BINDING_ORIGIN", `許可されていない origin: ${origin}`, "baseUrl"),
      );
    }
  }

  const specEvents = new Map(spec.events.map((e) => [e.id, e]));
  const specVars = new Map(spec.states.map((s) => [s.id, s]));
  const specProps = new Map(spec.properties.map((p) => [p.id, p]));

  const events: BoundEvent[] = [];
  if (!Array.isArray(input.events)) {
    diags.push(diag("BINDING_EVENTS", "events は配列である必要があります"));
  } else {
    const seen = new Set<string>();
    for (const [i, e] of input.events.entries()) {
      const p = `events[${i}]`;
      if (!isObj(e) || typeof e.event !== "string" || !specEvents.has(e.event)) {
        diags.push(diag("BINDING_EVENT_REF", `未定義イベント: ${String(isObj(e) ? e.event : e)}`, p));
        continue;
      }
      if (seen.has(e.event)) {
        diags.push(diag("BINDING_DUP", `イベント対応が重複: ${e.event}`, p));
        continue;
      }
      seen.add(e.event);
      const actions: Action[] = [];
      if (!Array.isArray(e.actions)) {
        diags.push(diag("BINDING_ACTIONS", "actions は配列である必要があります", p));
        continue;
      }
      for (const [j, a] of e.actions.entries()) {
        const act = checkAction(a, `${p}.actions[${j}]`, diags);
        if (act) actions.push(act);
      }
      const bound: BoundEvent = { event: e.event, actions };
      if (e.appMarker !== undefined) {
        const m = checkRead(e.appMarker, `${p}.appMarker`, diags);
        if (m) bound.appMarker = m;
      }
      if (typeof e.networkFixture === "string") bound.networkFixture = e.networkFixture;
      events.push(bound);
    }
    for (const ev of spec.events) {
      if (!seen.has(ev.id)) {
        diags.push(diag("BINDING_MISSING_EVENT", `イベント対応がありません: ${ev.id}`));
      }
    }
  }

  const observe: ObservationRule[] = [];
  if (!Array.isArray(input.observe)) {
    diags.push(diag("BINDING_OBSERVE", "observe は配列である必要があります"));
  } else {
    for (const [i, o] of input.observe.entries()) {
      const p = `observe[${i}]`;
      if (!isObj(o) || typeof o.variable !== "string" || !specVars.has(o.variable)) {
        diags.push(diag("BINDING_OBSERVE_REF", `未定義変数: ${String(isObj(o) ? o.variable : o)}`, p));
        continue;
      }
      const source = checkRead(o.source, `${p}.source`, diags);
      if (!source || !Array.isArray(o.cases)) {
        diags.push(diag("BINDING_OBSERVE", "source と cases が必要です", p));
        continue;
      }
      const domain = new Set(specVars.get(o.variable)!.domain);
      const cases = o.cases
        .filter(isObj)
        .map((c) => ({ observed: c.observed as Scalar, abstract: c.abstract as Scalar }));
      for (const c of cases) {
        if (!domain.has(c.abstract)) {
          diags.push(
            diag("BINDING_OBSERVE_DOMAIN", `抽象値 ${JSON.stringify(c.abstract)} は ${o.variable} の値域外です`, p),
          );
        }
      }
      observe.push({ variable: o.variable, source, cases });
    }
    for (const v of specVars.keys()) {
      if (!observe.some((o) => o.variable === v)) {
        diags.push(diag("BINDING_MISSING_OBSERVE", `観測規則がありません: ${v}`));
      }
    }
  }

  const oracles: OracleRule[] = [];
  if (!Array.isArray(input.oracles)) {
    diags.push(diag("BINDING_ORACLES", "oracles は配列である必要があります"));
  } else {
    for (const [i, o] of input.oracles.entries()) {
      const p = `oracles[${i}]`;
      if (!isObj(o) || typeof o.property !== "string" || !specProps.has(o.property)) {
        diags.push(diag("BINDING_ORACLE_REF", `未定義プロパティ: ${String(isObj(o) ? o.property : o)}`, p));
        continue;
      }
      if (typeof o.inputId !== "string" || typeof o.afterEvent !== "string" || !specEvents.has(o.afterEvent)) {
        diags.push(diag("BINDING_ORACLE", "inputId と afterEvent(既知イベント) が必要です", p));
        continue;
      }
      const actual = checkRead(o.actual, `${p}.actual`, diags);
      if (!actual) continue;
      oracles.push({
        property: o.property,
        inputId: o.inputId,
        afterEvent: o.afterEvent,
        actual,
      });
    }
  }

  const parseActions = (v: unknown, path: string): Action[] => {
    if (!Array.isArray(v)) return [];
    const out: Action[] = [];
    for (const [i, a] of v.entries()) {
      const act = checkAction(a, `${path}[${i}]`, diags);
      if (act) out.push(act);
    }
    return out;
  };

  const network: NetworkFixture[] = [];
  if (input.network !== undefined) {
    if (!Array.isArray(input.network)) {
      diags.push(diag("BINDING_NETWORK", "network は配列である必要があります"));
    } else {
      for (const [i, n] of input.network.entries()) {
        const p = `network[${i}]`;
        if (!isObj(n) || typeof n.id !== "string" || typeof n.path !== "string" || typeof n.status !== "number") {
          diags.push(diag("BINDING_NETWORK", "network には id/path/status が必要です", p));
          continue;
        }
        network.push({
          id: n.id,
          path: n.path,
          status: n.status,
          body: typeof n.body === "string" ? n.body : undefined,
        });
      }
    }
  }

  const selfTest: Read[] = [];
  if (input.selfTest !== undefined) {
    if (!Array.isArray(input.selfTest)) {
      diags.push(diag("BINDING_SELFTEST", "selfTest は配列である必要があります"));
    } else {
      for (const [i, r] of input.selfTest.entries()) {
        const rd = checkRead(r, `selfTest[${i}]`, diags);
        if (rd) selfTest.push(rd);
      }
    }
  }

  if (diags.length > 0) return { diagnostics: diags };

  return {
    binding: {
      schemaVersion: BINDING_SCHEMA_VERSION,
      baseUrl: input.baseUrl as string,
      events,
      observe,
      oracles,
      setup: parseActions(input.setup, "setup"),
      reset: parseActions(input.reset, "reset"),
      network,
      selfTest,
    },
    diagnostics: diags,
  };
}
