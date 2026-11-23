import {
  chromium,
  type APIResponse,
  type Browser,
  type BrowserContext,
  type Page,
  type Route,
} from "playwright";
import type {
  AbstractState,
  Diagnostic,
  Observation,
  Scalar,
} from "./ir.ts";
import type {
  Action,
  Binding,
  BoundEvent,
  ConcreteInput,
  Locator,
  NetworkFixture,
  Read,
  RuntimeConfig,
} from "./binding.ts";
import type { ObserveResult, ReadResult, UXAdapter } from "./adapter.ts";

function diag(code: string, message: string): Diagnostic {
  return { code, message };
}

function locatorKey(l: Locator): string {
  return `${l.kind}:${l.value}${l.name ? ":" + l.name : ""}`;
}

// binding.network の path は glob。"**" "*" "?" を含むパターンを URL に適用する。
function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

function fixtureMatches(fx: NetworkFixture, url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const re = globToRegExp(fx.path);
  return re.test(u.pathname + u.search) || re.test(url);
}

// FR-12: 共通 Playwright アダプター。フレームワーク非依存で DOM/ARIA/testid を使う。
export class PlaywrightAdapter implements UXAdapter {
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  private config: RuntimeConfig;
  private baseUrl: string;
  private binding?: Binding;
  // per-event networkFixture: 実行中のイベントが指定した fixture id
  private activeFixtureId?: string;
  // hold fixture ごとの保留キュー（route.fetch() 済み・応答未配信）
  private held = new Map<string, { route: Route; response: APIResponse }[]>();

  constructor(binding: Binding, config: RuntimeConfig) {
    this.binding = binding;
    this.baseUrl = binding.baseUrl;
    this.config = config;
  }

  private pwLocator(l: Locator) {
    const page = this.page!;
    switch (l.kind) {
      case "role":
        return page.getByRole(l.value as never, l.name ? { name: l.name } : undefined);
      case "ariaLabel":
        return page.getByLabel(l.value);
      case "testId":
        return page.getByTestId(l.value);
    }
  }

  // 決定的なネットワーク応答: binding.network を route.fulfill で登録する。
  // networkFixture 指定のイベント実行中はその fixture を優先する。
  private selectFixture(url: string): NetworkFixture | undefined {
    const fixtures = this.binding?.network ?? [];
    const candidates = fixtures.filter((f) => fixtureMatches(f, url));
    if (candidates.length === 0) return undefined;
    candidates.sort((a, b) => (a.id < b.id ? -1 : 1));
    // hold fixture はイベントが明示的に有効化した場合のみ適用する。
    // 非活性時に候補へ残すと、関係ない要求まで保留されてしまう。
    const eligible = candidates.filter(
      (f) => f.mode !== "hold" || f.id === this.activeFixtureId,
    );
    if (eligible.length === 0) return undefined;
    if (this.activeFixtureId !== undefined) {
      const active = eligible.find((f) => f.id === this.activeFixtureId);
      if (active) return active;
    }
    return eligible[0];
  }

  private async newContext(): Promise<void> {
    this.context = await this.browser!.newContext();
    this.held = new Map();
    await this.context.route("**/*", async (route) => {
      const fx = this.selectFixture(route.request().url());
      if (fx?.mode === "hold") {
        const postData = route.request().postData() ?? "";
        if (fx.matchBody !== undefined && !postData.includes(fx.matchBody)) {
          await route.continue();
          return;
        }
        try {
          // 実サーバーへは通し、応答だけを保留する（要求の到着順は実時間どおり）
          const response = await route.fetch();
          const q = this.held.get(fx.id) ?? [];
          q.push({ route, response });
          this.held.set(fx.id, q);
        } catch {
          await route.abort();
        }
        return;
      }
      if (!fx) {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: fx.status,
        body: fx.body ?? "",
        contentType: "application/json",
      });
    });
    this.page = await this.context.newPage();
  }

  async setup(): Promise<Diagnostic[]> {
    try {
      this.browser = await chromium.launch();
      await this.newContext();
      await this.page!.goto(this.baseUrl, { waitUntil: "load" });
      return [];
    } catch (e) {
      return [diag("ADAPTER_ERROR", `setup 失敗: ${(e as Error).message}`)];
    }
  }

  async reset(_attempt = 0): Promise<Diagnostic[]> {
    // NFR-03: テストごとに独立ブラウザーコンテキストで隔離
    try {
      await this.context?.close();
      await this.newContext();
      await this.page!.goto(this.baseUrl, { waitUntil: "load" });
      return [];
    } catch (e) {
      return [diag("ADAPTER_ERROR", `reset 失敗: ${(e as Error).message}`)];
    }
  }

  async act(actions: Action[], inputs: ConcreteInput[]): Promise<Diagnostic[]> {
    const out: Diagnostic[] = [];
    for (const a of actions) {
      try {
        switch (a.kind) {
          case "navigate": {
            const url = new URL(a.path ?? "/", this.baseUrl);
            if (!this.config.allowedOrigins.includes(url.origin)) {
              out.push(
                diag(
                  "ADAPTER_ERROR",
                  `許可されていない origin への navigate: ${url.origin} (allowed: ${this.config.allowedOrigins.join(",")})`,
                ),
              );
              return out;
            }
            await this.page!.goto(url.toString(), { waitUntil: "load" });
            break;
          }
          case "click":
            await this.pwLocator(a.locator!).click({ timeout: this.config.timeoutMs });
            break;
          case "fill": {
            const input = inputs.find((i) => i.id === a.inputId);
            await this.pwLocator(a.locator!).fill(input?.value ?? a.value ?? "", {
              timeout: this.config.timeoutMs,
            });
            break;
          }
          case "reload":
            await this.page!.reload({ waitUntil: "load" });
            break;
          case "back":
            await this.page!.goBack({ waitUntil: "load" });
            break;
          case "wait": {
            if (a.condition && a.expected !== undefined) {
              const deadline = Date.now() + this.config.timeoutMs;
              for (;;) {
                const r = await this.read(a.condition);
                if (r.value === a.expected) break;
                if (Date.now() > deadline) {
                  out.push(diag("ADAPTER_ERROR", "wait 条件がタイムアウトしました"));
                  return out;
                }
                await this.page!.waitForTimeout(50);
              }
            }
            break;
          }
          case "expectHeld": {
            // 保留要求が expected 件になるまで待つ（要求捕捉の同期点）
            const want = typeof a.expected === "number" ? a.expected : NaN;
            if (!a.fixture || !Number.isSafeInteger(want)) {
              out.push(diag("ADAPTER_ERROR", "expectHeld には fixture と数値 expected が必要です"));
              return out;
            }
            const deadline = Date.now() + this.config.timeoutMs;
            for (;;) {
              const n = this.held.get(a.fixture)?.length ?? 0;
              if (n === want) break;
              if (Date.now() > deadline) {
                out.push(
                  diag(
                    "ADAPTER_ERROR",
                    `expectHeld タイムアウト: ${a.fixture} の保留数 ${n} != ${want}`,
                  ),
                );
                return out;
              }
              await this.page!.waitForTimeout(50);
            }
            break;
          }
          case "release": {
            // 保留キューから1件取り出して応答を配信する。
            // index: 0=最古（既定）、負数は末尾から（-1=最新）。
            if (!a.fixture) {
              out.push(diag("ADAPTER_ERROR", "release には fixture が必要です"));
              return out;
            }
            const q = this.held.get(a.fixture) ?? [];
            if (q.length === 0) {
              out.push(
                diag("ADAPTER_ERROR", `release 対象の保留要求がありません: ${a.fixture}`),
              );
              return out;
            }
            const idx = a.index ?? 0;
            const i = idx < 0 ? q.length + idx : idx;
            if (i < 0 || i >= q.length) {
              out.push(
                diag("ADAPTER_ERROR", `release index が範囲外です: ${idx} (件数 ${q.length})`),
              );
              return out;
            }
            const [item] = q.splice(i, 1);
            if (q.length === 0) this.held.delete(a.fixture);
            try {
              await item.route.fulfill({ response: item.response });
            } catch (e) {
              out.push(diag("ADAPTER_ERROR", `release 失敗: ${(e as Error).message}`));
              return out;
            }
            break;
          }
        }
      } catch (e) {
        out.push(
          diag(
            "ADAPTER_ERROR",
            `action ${a.kind} 失敗 (${locatorKey(a.locator ?? { kind: "testId", value: "" })}): ${(e as Error).message}`,
          ),
        );
        return out;
      }
    }
    return out;
  }

  async execute(bound: BoundEvent, inputs: ConcreteInput[]) {
    // per-event networkFixture: このイベントの actions 実行中のみ有効化する
    const prev = this.activeFixtureId;
    this.activeFixtureId = bound.networkFixture;
    try {
      return await this.act(bound.actions, inputs);
    } finally {
      this.activeFixtureId = prev;
    }
  }

  async read(read: Read): Promise<ReadResult> {
    try {
      const loc = this.pwLocator(read.locator);
      let value: Scalar | undefined;
      if (read.kind === "attribute" && read.attribute) {
        value = (await loc.getAttribute(read.attribute, { timeout: this.config.timeoutMs })) ?? undefined;
      } else if (read.kind === "value") {
        value = await loc.inputValue({ timeout: this.config.timeoutMs });
      } else {
        value = await loc.innerText({ timeout: this.config.timeoutMs });
      }
      if (value === undefined || value === null) {
        return { diagnostics: [diag("ADAPTER_ERROR", `read が値を返しません: ${locatorKey(read.locator)}`)] };
      }
      return { value, diagnostics: [] };
    } catch (e) {
      return {
        diagnostics: [
          diag("ADAPTER_ERROR", `read 失敗 (${locatorKey(read.locator)}): ${(e as Error).message}`),
        ],
      };
    }
  }

  async observe(): Promise<ObserveResult> {
    const values = new Map<string, Scalar>();
    const diagnostics: Diagnostic[] = [];
    for (const rule of this.bindingObserve()) {
      const r = await this.read(rule.source);
      diagnostics.push(...r.diagnostics);
      if (r.diagnostics.length > 0 || r.value === undefined) {
        return { diagnostics: r.diagnostics.length ? r.diagnostics : [diag("ADAPTER_ERROR", "観測失敗")] };
      }
      const c = rule.cases.find((c) => c.observed === r.value);
      if (!c) {
        return {
          diagnostics: [
            diag("OBSERVE_UNMAPPED", `観測値 ${JSON.stringify(r.value)} に対応する抽象値がありません: ${rule.variable}`),
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
    const observation: Observation = { state, provenance: "runner" };
    return { observation, diagnostics };
  }

  private bindingObserve() {
    return this.binding?.observe ?? [];
  }

  async selfTest(): Promise<Diagnostic[]> {
    const out: Diagnostic[] = [];
    for (const r of this.binding?.selfTest ?? []) {
      const res = await this.read(r);
      out.push(...res.diagnostics);
    }
    return out;
  }

  async teardown(): Promise<Diagnostic[]> {
    try {
      await this.context?.close();
      await this.browser?.close();
      return [];
    } catch (e) {
      return [diag("ADAPTER_ERROR", `teardown 失敗: ${(e as Error).message}`)];
    }
  }
}
