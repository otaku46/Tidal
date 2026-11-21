import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { validateSpec } from "./spec.ts";
import { compileSpec } from "./dsl.ts";
import { exploreModel } from "./model.ts";
import { checkProperties } from "./properties.ts";
import { aggregateResults, ALL_TARGETS, resolveScope } from "./reporting.ts";
import { resolveBinding, loadBindingJson, type RuntimeConfig } from "./binding.ts";
import { runRuntimeChecks } from "./runtime.ts";
import { makeMockAdapter } from "./fixtures.ts";
import { PlaywrightAdapter } from "./playwright-adapter.ts";
import type {
  DslDefinition,
  ModelGraph,
  Report,
  RunResults,
  RunScope,
  RunSelection,
  Target,
  UxSpec,
} from "./ir.ts";

export const IMPLEMENTED_TARGETS: Target[] = ["model", "conformance", "implementation"];

export interface CliOptions {
  targets?: Target[];
  out?: string;
  seed?: string;
  binding?: string;
  fixture?: string;
  adapter?: "mock" | "playwright";
  replayAttempts?: number;
  minimizeAttempts?: number;
}

function parseArgs(argv: string[]): { specPath?: string; options: CliOptions } {
  const options: CliOptions = {};
  let specPath: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--targets" && argv[i + 1]) {
      options.targets = next().split(",").map((s) => s.trim()) as Target[];
    } else if (a === "--out" && argv[i + 1]) {
      options.out = next();
    } else if (a === "--seed" && argv[i + 1]) {
      options.seed = next();
    } else if (a === "--binding" && argv[i + 1]) {
      options.binding = next();
    } else if (a === "--fixture" && argv[i + 1]) {
      options.fixture = next();
    } else if (a === "--adapter" && argv[i + 1]) {
      options.adapter = next() as "mock" | "playwright";
    } else if (a === "--replay" && argv[i + 1]) {
      options.replayAttempts = parseInt(next(), 10);
    } else if (a === "--minimize" && argv[i + 1]) {
      options.minimizeAttempts = parseInt(next(), 10);
    } else if (!a.startsWith("--")) {
      specPath = a;
    }
  }
  return { specPath, options };
}

// func.runCli: spec.json + binding + scope → report.json + exit code (NFR-07)
export async function runCli(argv: string[]): Promise<number> {
  const { specPath, options } = parseArgs(argv);
  if (!specPath) {
    console.error(
      "usage: tidal <spec.json|spec.ts> [--targets model,conformance,implementation] [--binding binding.json] [--fixture name] [--out report.json] [--seed seed] [--replay n] [--minimize n]",
    );
    return 3;
  }

  // F6: target 名と adapter 名を検証する（未知値は入力エラー）
  if (options.targets !== undefined) {
    if (options.targets.length === 0) {
      console.error("--targets が空です");
      return 3;
    }
    const bad = options.targets.filter((t) => !ALL_TARGETS.includes(t));
    if (bad.length > 0) {
      console.error(`未知の target: ${bad.join(", ")} (有効: ${ALL_TARGETS.join(", ")})`);
      return 3;
    }
  }
  if (options.adapter !== undefined && options.adapter !== "mock" && options.adapter !== "playwright") {
    console.error(`未知の adapter: ${String(options.adapter)}`);
    return 3;
  }

  let raw: unknown;
  try {
    if (/\.tsx?$/.test(specPath)) {
      // F9: DSL (.ts) 入力。specification / spec / default のいずれかを受け付け、
      // DslDefinition なら compileSpec で JSON IR に落とす。検証は validateSpec で共通。
      const mod = (await import(pathToFileURL(resolve(specPath)).href)) as Record<
        string,
        unknown
      >;
      const candidate =
        mod.specification ?? mod.spec ?? mod.default;
      if (candidate === undefined || candidate === null || typeof candidate !== "object") {
        console.error(`spec module から specification を取得できません: ${specPath}`);
        return 3;
      }
      raw =
        "specification" in (candidate as object)
          ? compileSpec(candidate as DslDefinition)
          : candidate;
    } else {
      raw = JSON.parse(readFileSync(specPath, "utf8"));
    }
  } catch (e) {
    console.error(`failed to read/parse spec: ${(e as Error).message}`);
    return 3;
  }

  const { spec, diagnostics } = validateSpec(raw);

  const scope: RunScope = { targets: options.targets };
  const selection: RunSelection = { requested: scope, declared: [...ALL_TARGETS] };
  const { context, notEvaluated: scopeNotEvaluated } = resolveScope(selection, IMPLEMENTED_TARGETS, {
    analysis: spec?.analysis,
    seed: options.seed,
    environment: {
      adapter: options.adapter ?? "mock",
      fixture: options.fixture,
    },
    reproduction: {
      seed: options.seed ?? "default",
      binding: options.binding,
    },
  });

  const run: RunResults = {
    context,
    results: [],
    coverage: [],
    diagnostics: [...diagnostics],
    notEvaluated: [...scopeNotEvaluated],
  };

  if (spec) {
    const effective = new Set(context.effectiveTargets);
    let graph: ModelGraph | undefined;

    if (effective.has("model")) {
      const explored = exploreModel(spec);
      graph = explored.graph;
      run.diagnostics.push(...explored.diagnostics);
      const checked = checkProperties(spec, graph, context);
      run.results.push(...checked.results);
      run.coverage.push(...checked.coverage);
      run.diagnostics.push(...checked.diagnostics);
    } else {
      // runtime targets still need the explored graph for traces
      graph = exploreModel(spec).graph;
    }

    const wantsRuntime = effective.has("conformance") || effective.has("implementation");
    if (wantsRuntime) {
      if (!options.binding) {
        for (const t of ["conformance", "implementation"] as const) {
          if (effective.has(t)) {
            run.notEvaluated.push({ target: t, reason: "BLOCKED" });
          }
        }
      } else {
        try {
          const bindingRaw = loadBindingJson(options.binding);
          let origin = "";
          try {
            origin = new URL((bindingRaw as { baseUrl?: string }).baseUrl ?? "").origin;
          } catch {
            /* resolveBinding reports it */
          }
          const config: RuntimeConfig = {
            allowedOrigins: origin ? [origin] : [],
            timeoutMs: 5000,
            replayAttempts: options.replayAttempts ?? 2,
            seed: options.seed ?? "default",
            minimizeAttempts: options.minimizeAttempts,
          };
          const { binding, diagnostics: bindDiags } = resolveBinding(bindingRaw, spec, config);
          run.diagnostics.push(...bindDiags);
          if (!binding) {
            for (const t of ["conformance", "implementation"] as const) {
              if (effective.has(t)) {
                run.notEvaluated.push({ target: t, reason: "BLOCKED" });
              }
            }
          } else {
            const adapter =
              options.adapter === "playwright"
                ? new PlaywrightAdapter(binding, config)
                : makeMockAdapter(options.fixture ?? "retains", binding);
            const rt = await runRuntimeChecks(graph, binding, config, context, adapter);
            run.results.push(...rt.results);
            run.coverage.push(...rt.coverage);
            run.diagnostics.push(...rt.diagnostics);
            run.notEvaluated.push(...rt.notEvaluated);
          }
        } catch (e) {
          run.diagnostics.push({
            code: "ADAPTER_ERROR",
            message: `binding 読み込み失敗: ${(e as Error).message}`,
          });
        }
      }
    }
  }

  const report: Report = aggregateResults(run);
  const outPath = options.out ?? "report.json";
  writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n");

  console.log(`overall: ${report.overall} (exit ${report.exitCode})`);
  for (const t of report.targets) {
    console.log(`  ${t.target}: ${t.verdict ?? "NOT_EVALUATED"}`);
  }
  console.log(`report: ${outPath}`);
  return report.exitCode;
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  runCli(process.argv.slice(2)).then((code) => process.exit(code));
}
