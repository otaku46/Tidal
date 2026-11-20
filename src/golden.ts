import type {
  Diagnostic,
  GoldenCase,
  GoldenExpectation,
  Report,
} from "./ir.ts";

function diag(code: string, message: string): Diagnostic {
  return { code, message };
}

// func.checkVerdictInvariants: FR-29 / I1〜I5
export function checkVerdictInvariants(
  report: Report,
  expected: GoldenExpectation,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  const push = (inv: string, msg: string) =>
    out.push(diag(`INVARIANT_${inv}`, msg));

  // I1: 確定違反には対応する有効な証拠が存在する
  for (const v of report.confirmedViolations) {
    const ok = v.evidence.some((e) => {
      if (v.target === "model") return e.kind === "MODEL_COUNTEREXAMPLE";
      if (v.target === "implementation") return e.kind === "INDEPENDENT_ORACLE";
      return false; // conformance の観測不一致だけでは CONFIRMED にしない
    });
    if (!ok) {
      push("I1", `CONFIRMED ${v.target}/${v.property} に有効な証拠がありません`);
    }
  }
  // conformance target が CONFIRMED になっていないこと
  for (const t of report.targets) {
    if (t.target === "conformance" && t.verdict === "CONFIRMED") {
      push("I3", "conformance target が CONFIRMED になっています（観測不一致のみでは確定不可）");
    }
  }

  // I2: モデル検査に FLAKY を付与しない・モデルは決定的
  for (const t of report.targets) {
    if (t.target === "model") {
      for (const p of t.properties) {
        if (p.verdict === "FLAKY") {
          push("I2", `model プロパティ ${p.property} に FLAKY が付与されています`);
        }
      }
      if (t.verdict === "FLAKY") push("I2", "model target が FLAKY です");
    }
  }

  // I4: 未評価対象と実行スコープを隠さない
  const effective = new Set(report.context.effectiveTargets);
  for (const t of report.targets) {
    if (!effective.has(t.target) && t.verdict !== undefined) {
      push("I4", `スコープ外 target ${t.target} に判定が付いています`);
    }
  }
  // NOT_REQUESTED の target が notEvaluated に記録されていること
  const requested = report.context.scope.targets;
  if (requested !== undefined) {
    for (const t of ["model", "conformance", "implementation"] as const) {
      if (!requested.includes(t)) {
        const recorded = report.notEvaluated.some(
          (n) => n.target === t && n.reason === "NOT_REQUESTED",
        );
        if (!recorded) {
          push("I4", `スコープ外 ${t} の NOT_REQUESTED が記録されていません`);
        }
      }
    }
  }

  // I5: 証拠の依存先が故障している場合に無効な確定判定をしない
  const adapterFailed = report.errors.some(
    (d) => d.code === "ADAPTER_ERROR" || d.code === "ADAPTER_SELFTEST_FAILED",
  );
  if (adapterFailed) {
    for (const v of report.confirmedViolations) {
      for (const e of v.evidence) {
        if (e.dependencies.includes("adapter")) {
          push("I5", `アダプター障害下で adapter 依存の確定証拠があります: ${e.id}`);
        }
      }
    }
  }

  // 期待値との照合（項目単位。証拠全体のスナップショット一致は要求しない）
  if (report.overall !== expected.overall) {
    push("EXPECT", `overall 期待 ${expected.overall} 実際 ${report.overall}`);
  }
  if (report.exitCode !== expected.exitCode) {
    push("EXPECT", `exitCode 期待 ${expected.exitCode} 実際 ${report.exitCode}`);
  }
  if (expected.cause) {
    const found = [
      ...report.targets.flatMap((t) => t.properties),
      ...report.notEvaluated,
    ].some((r) => "causes" in r ? r.causes.includes(expected.cause!) : r.cause === expected.cause);
    if (!found) push("EXPECT", `cause ${expected.cause} が結果に存在しません`);
  }
  if (expected.evidenceKind) {
    const found = report.evidence.some((e) => e.kind === expected.evidenceKind);
    if (!found) push("EXPECT", `evidenceKind ${expected.evidenceKind} が存在しません`);
  }
  for (const field of expected.requiredEvidenceFields) {
    const found = report.evidence.some((e) => {
      const cx = e.counterexample as unknown as Record<string, unknown>;
      const v = cx[field];
      return v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0);
    });
    if (!found) push("EXPECT", `必須証拠フィールド ${field} が空です`);
  }

  return out;
}

export type GoldenRunner = (c: GoldenCase) => Promise<Report>;

// func.runGoldenCases: ケース実行 + 期待判定 + 不変条件
export async function runGoldenCases(
  cases: GoldenCase[],
  runner: GoldenRunner,
): Promise<Diagnostic[]> {
  const diags: Diagnostic[] = [];
  for (const c of cases) {
    let report: Report;
    try {
      report = await runner(c);
    } catch (e) {
      diags.push(diag("GOLDEN_RUNNER_ERROR", `${c.id}: ${(e as Error).message}`));
      continue;
    }
    const problems = checkVerdictInvariants(report, c.expected);
    for (const p of problems) {
      diags.push({ ...p, message: `${c.id}: ${p.message}` });
    }
  }
  return diags;
}
