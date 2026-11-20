import type {
  AbstractState,
  Diagnostic,
  Observation,
  Scalar,
} from "./ir.ts";
import type { Action, Binding, BoundEvent, ConcreteInput, Read } from "./binding.ts";
import { stateKey } from "./eval.ts";

// FR-11: 共通アダプター契約（概念上の最小契約 + read/selfTest）
export interface ObserveResult {
  observation?: Observation;
  diagnostics: Diagnostic[];
}

export interface ReadResult {
  value?: Scalar;
  diagnostics: Diagnostic[];
}

export interface UXAdapter {
  setup(): Promise<Diagnostic[]>;
  reset(attempt?: number): Promise<Diagnostic[]>;
  execute(bound: BoundEvent, inputs: ConcreteInput[]): Promise<Diagnostic[]>;
  act(actions: Action[], inputs: ConcreteInput[]): Promise<Diagnostic[]>;
  observe(): Promise<ObserveResult>;
  read(read: Read): Promise<ReadResult>;
  selfTest(): Promise<Diagnostic[]>;
  teardown(): Promise<Diagnostic[]>;
}

function diag(code: string, message: string): Diagnostic {
  return { code, message };
}

// ---- independent mock applications (FR-28) ----
// These do NOT share the model's transition function. Each holds concrete
// values and decides behavior independently.

export interface MockApp {
  readonly name: string;
  reset(): void;
  // returns diagnostics; may simulate locator failure
  perform(action: Action, inputs: ConcreteInput[], attempt: number): Diagnostic[];
  // undefined → locator/element not found
  read(read: Read, attempt: number): Scalar | undefined;
}

export class LocatorFailureApp implements MockApp {
  readonly name = "locator-failure";
  reset(): void {}
  perform(): Diagnostic[] {
    return [];
  }
  read(): Scalar | undefined {
    return undefined; // every locator is broken
  }
}

export class DraftApp implements MockApp {
  readonly name: string;
  draft = "";
  saved = false;
  private loseDraft: "never" | "always" | ((attempt: number) => boolean);

  // loseDraft: 'never' | 'always' | (attempt) => boolean
  constructor(
    name: string,
    loseDraft: "never" | "always" | ((attempt: number) => boolean) = "never",
  ) {
    this.name = name;
    this.loseDraft = loseDraft;
  }

  reset(): void {
    this.draft = "";
    this.saved = false;
  }

  perform(action: Action, inputs: ConcreteInput[], attempt: number): Diagnostic[] {
    switch (action.kind) {
      case "fill": {
        const input = inputs.find((i) => i.id === action.inputId);
        this.draft = input?.value ?? action.value ?? "";
        this.saved = false;
        break;
      }
      case "click": {
        const v = action.locator?.value ?? "";
        if (v.startsWith("save")) this.saved = true;
        else if (v.startsWith("discard")) {
          this.draft = "";
          this.saved = false;
        }
        break;
      }
      case "reload": {
        const lose =
          this.loseDraft === "always" ||
          (typeof this.loseDraft === "function" && this.loseDraft(attempt));
        if (lose) {
          this.draft = "";
          this.saved = false;
        }
        break;
      }
      default:
        break;
    }
    return [];
  }

  read(read: Read, _attempt = 0): Scalar | undefined {
    const key = `${read.locator.kind}:${read.locator.value}`;
    if (key === "testId:draft-status") {
      if (this.draft === "") return "empty";
      return this.saved ? "saved" : "dirty";
    }
    if (key === "testId:draft-input") {
      return read.kind === "value" ? this.draft : this.draft === "" ? "empty" : "dirty";
    }
    return undefined;
  }
}

// edit イベントを無視する独立実装（AC-04: MODEL_DIVERGENCE → INCONCLUSIVE の検証用）
export class IgnoreFillApp extends DraftApp {
  constructor() {
    super("ignores-edit", "never");
  }
  override perform(action: Action, inputs: ConcreteInput[], attempt: number): Diagnostic[] {
    if (action.kind === "fill") return [];
    return super.perform(action, inputs, attempt);
  }
}

// saved 状態からの reload でのみ下書きを失う独立実装。
// edge 単位カバレッジ（transition@from）の検証用: dirty/empty からの
// reload は保持するが saved からの reload で消失する。
export class LosesSavedOnReloadApp extends DraftApp {
  constructor() {
    super("loses-saved-on-reload", "never");
  }
  override perform(action: Action, inputs: ConcreteInput[], attempt: number): Diagnostic[] {
    if (action.kind === "reload" && this.saved) {
      this.draft = "";
      this.saved = false;
      return [];
    }
    return super.perform(action, inputs, attempt);
  }
}

// attempt 0 は下書きを失う（MISMATCH）、attempt>=1 は oracle 読み取りが失敗する
// 独立実装。決定表「MISMATCH + ERROR → INCONCLUSIVE」の検証用。
export class OracleErrorApp extends DraftApp {
  constructor() {
    super("oracle-error", "always");
  }
  override read(read: Read, attempt: number): Scalar | undefined {
    // oracle の actual(draft-input) のみ失敗させ、観測(draft-status)は成功させる
    if (attempt >= 1 && read.locator.value === "draft-input") return undefined;
    return super.read(read);
  }
}

// ---- MockAdapter: UXAdapter over a MockApp ----

export class MockAdapter implements UXAdapter {
  private attempt = 0;
  private app: MockApp;
  private binding: Binding;

  constructor(app: MockApp, binding: Binding) {
    this.app = app;
    this.binding = binding;
  }

  async setup(): Promise<Diagnostic[]> {
    return this.act(this.binding.setup, []);
  }

  async reset(attempt = 0): Promise<Diagnostic[]> {
    this.attempt = attempt;
    this.app.reset();
    return this.act(this.binding.reset, []);
  }

  async execute(bound: BoundEvent, inputs: ConcreteInput[]): Promise<Diagnostic[]> {
    return this.act(bound.actions, inputs);
  }

  async act(actions: Action[], inputs: ConcreteInput[]): Promise<Diagnostic[]> {
    const out: Diagnostic[] = [];
    for (const a of actions) {
      // resolve fill values from inputs
      const effective =
        a.kind === "fill" && a.inputId
          ? inputs.find((i) => i.id === a.inputId)
          : undefined;
      const action: Action = effective ? { ...a, value: effective.value } : a;
      const ds = this.app.perform(action, inputs, this.attempt);
      out.push(...ds);
      for (const d of ds) {
        if (d.code === "LOCATOR_NOT_FOUND") {
          return [diag("ADAPTER_ERROR", `locator not found: ${JSON.stringify(a.locator)}`)];
        }
      }
    }
    return out;
  }

  async observe(): Promise<ObserveResult> {
    const values = new Map<string, Scalar>();
    const diagnostics: Diagnostic[] = [];
    for (const rule of this.binding.observe) {
      const r = await this.read(rule.source);
      diagnostics.push(...r.diagnostics);
      if (r.value === undefined) {
        return {
          diagnostics: [
            diag("ADAPTER_ERROR", `観測失敗: ${rule.variable} (${rule.source.locator.value})`),
          ],
        };
      }
      const c = rule.cases.find((c) => c.observed === r.value);
      if (!c) {
        return {
          diagnostics: [
            diag(
              "OBSERVE_UNMAPPED",
              `観測値 ${JSON.stringify(r.value)} に対応する抽象値がありません: ${rule.variable}`,
            ),
          ],
        };
      }
      values.set(rule.variable, c.abstract);
    }
    const state: AbstractState = {
      values: [...values.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([variable, value]) => ({ variable, value })),
    };
    return {
      observation: { state, provenance: "runner" },
      diagnostics,
    };
  }

  async read(read: Read): Promise<ReadResult> {
    const value = this.app.read(read, this.attempt);
    if (value === undefined) {
      return {
        diagnostics: [
          diag("ADAPTER_ERROR", `locator not found: ${read.locator.kind}:${read.locator.value}`),
        ],
      };
    }
    return { value, diagnostics: [] };
  }

  async selfTest(): Promise<Diagnostic[]> {
    const out: Diagnostic[] = [];
    for (const r of this.binding.selfTest) {
      const res = await this.read(r);
      out.push(...res.diagnostics);
    }
    return out;
  }

  async teardown(): Promise<Diagnostic[]> {
    return [];
  }
}

export { stateKey };

// ---- IR func wrappers (design/adapter.toml) ----
// Thin delegates over the UXAdapter contract so pipelines can reference
// func names directly.

export function setupAdapter(adapter: UXAdapter): Promise<Diagnostic[]> {
  return adapter.setup();
}

export function resetAdapter(adapter: UXAdapter, attempt?: number): Promise<Diagnostic[]> {
  return adapter.reset(attempt);
}

export function executeEvent(
  adapter: UXAdapter,
  bound: BoundEvent,
  inputs: ConcreteInput[],
): Promise<Diagnostic[]> {
  return adapter.execute(bound, inputs);
}

export function observeState(adapter: UXAdapter): Promise<ObserveResult> {
  return adapter.observe();
}

export function selfTestAdapter(adapter: UXAdapter): Promise<Diagnostic[]> {
  return adapter.selfTest();
}

export function teardownAdapter(adapter: UXAdapter): Promise<Diagnostic[]> {
  return adapter.teardown();
}
