# Tidal

Web アプリの UX の振る舞いを宣言的な仕様として書き、その仕様を実装が満たすかを検査するツールです。

仕様は「状態」「イベント」「遷移」「性質」で記述します。Tidal はそこから操作列を生成し、次の 3 種類を分けて検査します。

1. **モデル検査**: 仕様だけを探索し、性質が成り立つかを調べる。
2. **適合性検査**: モデルの予測と、ブラウザーで観測した状態を比べる。
3. **具体値検証**: 抽象状態では見えないデータの損失を、独立したオラクルで調べる。

モデル検査が PASS でも、アプリの正しさを証明するものではありません。検査できるのは仕様に書いた性質と遷移だけです。

仕様の詳細は [docs/spec_tidal.md](docs/spec_tidal.md) を参照してください(日本語)。

## 状態

初期段階です。fixture の開閉パネル(disclosure)3フレームワーク、設定フォームのサンプル(`sample/`、`examples/profile.*`)、文書 playground(`examples/doc-playground.*`)、保存競合(`examples/save-conflict.*`)で検証できます。外部の実アプリでの運用実績はまだありません。

## 必要環境

- Node.js 22.18 以上
- Playwright(ブラウザ検証に使用)。`npm install` の postinstall で Chromium を取得します。CI では `npx playwright install-deps chromium` でシステム依存も入れます。

## セットアップ

```
npm install
npm run build:fixtures          # Svelte 版のビルド
node fixtures/server.mjs 4173   # サンプルアプリを配信(別ターミナルで起動したままにする)
```

fixture サーバーはリポジトリルートを配信し、`/api/docs` に試行ごとの文書永続化エンドポイントを持ちます(書き込みごとに `rev` を採番)。

## 使い方

モデル検査(仕様のみ、ブラウザー不要):

```
node src/cli.ts examples/disclosure.spec.json --targets model
```

ブラウザで検証(フレームワークごとに binding を指定):

```
node src/cli.ts examples/disclosure.spec.json --binding examples/disclosure.react.binding.json --adapter playwright --out report.json
node src/cli.ts examples/disclosure.spec.json --binding examples/disclosure.svelte.binding.json --adapter playwright --out report.json
node src/cli.ts examples/disclosure.spec.json --binding examples/disclosure.solid.binding.json --adapter playwright --out report.json
```

binding を省略するとモックアダプターで実行されます(ブラウザー不要のスモーク用)。

主なオプション:

| オプション | 内容 |
|---|---|
| `--targets` | 検査対象。`model,conformance,implementation` のカンマ区切り |
| `--binding` | 仕様のイベントを画面の操作に対応づける JSON |
| `--adapter` | 実行するアダプター(`playwright`) |
| `--out` | 機械可読レポートの出力先(JSON) |
| `--minimize n` | 反例の最小化で試す上限回数(既定 8) |
| `--replay n` | 不一致の再現確認を行う回数 |
| `--seed` | 具体入力の生成に使うシード(既定 `default`) |

## 仕様(UX Spec)の構造

`examples/*.spec.json` は `schemaVersion` / `kind: "tidal.uxSpec"` を持つ JSON です。

- `states`: 抽象状態変数と有限の値域(例: `pending: ["none","a","b","ab"]`)
- `initialState`: 初期値
- `events`: `user` / `browser` / `env` の種別付きイベント。`env` は同一 `(状態, イベント)` に複数の行き先を許す非決定分岐として扱われます
- `transitions`: `when` ガードと `set` 更新からなる遷移。式は `literal` / `ref` / `eq` / `ne` / `and` / `or` / `not`
- `properties`: 性質。`neverTransition`(禁止遷移)、`canReach`(到達可能性)、`escapable`(脱出可能性、`by:"user"` でユーザー辺のみに限定)
- `analysis`: `maxStates` / `maxDepth` / `maxTransitions` の探索上限と、`requiredTransitions`(必須分岐)

## binding(画面との対応づけ)

`examples/*.binding.json` が抽象イベントを DOM 操作に対応づけます。

- `events`: 各イベントの `actions`(下記)、`appMarker`(応答証跡)、`networkFixture`(このイベント中のみ有効化するネットワーク fixture)
- `observe`: DOM の読み取り値を抽象値へ写像する `cases` テーブル
- `oracles`: 具体値オラクル(後述)
- `network`: `path` / `status` / `body` のモック応答、または `mode:"hold"` の保留応答
- `setup` / `reset` / `selfTest`: 初期化・試行ごとの隔離・自己診断

アクションの種類: `navigate` `click` `fill` `reload` `back` `wait` `release` `expectHeld`。

`fill` は `inputId` があれば生成された具体入力値、なければ `value` を使います。`wait` は `condition`(Read)+`expected` が一致するまで待ちます。

### 応答の保留と順序制御(保存競合など)

`network` fixture に `mode:"hold"` と `matchBody`(必須)を指定すると、マッチした要求を実サーバーへ通しつつ応答だけを保留します。イベントの `networkFixture` で明示的に有効化した場合のみ適用されます。

- `expectHeld { fixture, expected }`: その fixture の保留要求が `expected` 件になるまで待つ(要求捕捉の同期点)
- `release { fixture, index }`: 保留キューから1件取り出して応答を配信。`index: 0` が最古、負数は末尾から(`-1` が最新)

これにより「要求の到着順 A→B、応答の解放順 B→A」のような順序を決定的に再現できます。捕捉できない・順序を作れない試行は `ADAPTER_ERROR` として報告されます。

### binding の継承

binding JSON は `"extends": "./親.json"` で共通定義を継承できます(トップレベルの浅いマージ、配列は子が置換、相対パス、循環はエラー)。フレームワーク共通部分を1ファイルにまとめ、`baseUrl` だけを差し替える運用を想定しています(例: `examples/disclosure.binding.json` + `disclosure.{react,solid,svelte}.binding.json`)。

## 具体値オラクル

`observe` の抽象写像では見えないデータ損失を検出するため、`oracles` で「入力した具体値が、あるイベントの後に画面へ残っているか」を宣言できます。

```json
{ "property": "saved_doc_never_lost", "inputId": "doc-body-text",
  "afterEvent": "reload",
  "actual": { "locator": { "kind": "testId", "value": "doc-body" }, "kind": "value" } }
```

- `property` は仕様側の性質 ID と対応づけます(モデル側の性質と具象値チェックを同じ ID で結びます)
- `inputId` を `fill` アクションが消費した後、`afterEvent` の実行直後に `actual` を読み、生成された具体入力値と一致するかを比較します
- 不一致は `INDEPENDENT_ORACLE` 証拠として `implementation: CONFIRMED` になります。観測不一致(`MODEL_DIVERGENCE`)とは別系統で、抽象状態への写像を経由しません

## 判定(5種類)

| 判定 | 意味 |
|---|---|
| `PASS` (exit 0) | 仕様どおり動いた |
| `CONFIRMED` (exit 1) | モデルまたは独立オラクルが違反を確定した |
| `INCONCLUSIVE` (exit 2) | 仕様と観測がずれた、または未評価対象が残った。アプリのバグとは確定していない |
| `FLAKY` (exit 2) | 同一操作列・入力・初期条件での再現結果が一致と不一致に分かれた |
| `ERROR` (exit 3) | 仕様・binding・アダプターなど検証機構自体の障害 |

観測の不一致だけでは実装のバグを確定しません。データの損失などを確定するには `oracles` を使います。不一致トレースは `replayAttempts` 回再実行され、再現結果が `evidence.replay` に記録されます(判定は `INCONCLUSIVE` のまま)。

## カバレッジと必須分岐

ランタイム検証は、モデルの各 `(from状態, event)` 選択点への最短経路をトレースとして生成・実行します。カバレッジは計画ではなく**実行結果**から集計し、観測が記録済み辺の行き先と一致した遷移と完了したイベントのみを数えます。attempt0 と replay の全試行を通して集計します。

- `analysis.requiredTransitions` に遷移 ID を列挙すると、その遷移が一度も観測一致しなかった場合に `notEvaluated` (`INCOMPLETE`/`COVERAGE_SHORT`) へ記録され、`PASS` を返しません
- env などの任意分岐が未観測の場合は `coverage.missingObligations` に `branch:` 形式で記録され `complete:false` になりますが、判定は妨げません
- 同一 `(from,event)` で複数の行き先があるのに一部しか観測されなかった場合も `branch:` として記録されます

部分探索(状態数・深度・遷移数の上限到達)では、到達不能が確定できる範囲だけ `CONFIRMED` にし、未探索領域が残る場合は `INCONCLUSIVE`/`EXPLORATION_LIMIT` にします。確定した反例と打ち切り情報は両方レポートに残ります。

## 反例と再現

- モデルの `CONFIRMED` には `MODEL_COUNTEREXAMPLE` 証拠(初期状態・イベント列・モデルステップ)が付きます
- 実装の `CONFIRMED` には `INDEPENDENT_ORACLE` 証拠(期待値・実測値・イベント列・再実行結果)が付きます
- `--minimize n` で、違反が同一に再現する範囲でステップを削る最小化を試みます(既定 8 回まで)。短縮できた場合は `minimized: true` になり、`events`/`observations` は最小化後のものに差し替わります

レポート(`--out` の JSON)には `context`(仕様・binding の版と実効スコープ)、`targets`(target 別の性質判定と原因コード)、`evidence`、`coverage`、`notEvaluated`、`errors` が含まれます。

## サンプル一覧

| 例 | 内容 |
|---|---|
| `examples/disclosure.*` | 開閉パネル。React/Solid/Svelte の3 fixture で同一仕様を検証。`note_survives_reload` オラクルで具体値の永続化も確認 |
| `examples/profile.*` + `sample/` | 設定フォーム(未保存・保存中・保存失敗・破棄確認・リロード) |
| `examples/doc-playground.*` | 文書の編集・保存・リロード playground。`playground`(正常)は PASS、`playground-lossy`(保存欠落)は `implementation: CONFIRMED` |
| `examples/save-conflict.*` | 保存競合。応答順序を制御して巻き戻りを検証(後述) |
| `examples/return-to-goal.spec.json` | 部分探索時の判定確認用(`goal→hidden→trap`) |
| `examples/draft-retention.*` | Golden Tests 用のモック fixture 例 |

### 別サンプル: profile 設定フォーム

`sample/react/index.html` は、未保存変更・保存中・保存失敗・破棄確認・リロードを扱う React のサンプルです。仕様と binding を使って、同じ CLI で検証できます。

```
node src/cli.ts examples/profile.spec.json --targets model
node src/cli.ts examples/profile.spec.json --binding examples/profile.react.binding.json --adapter playwright --out report.json
```

具体値オラクル `saved_value_survives_reload` が、保存した値がリロード後も残ることを個別に確認します。

### 別サンプル: 保存競合(レスポンス順序の巻き戻り)

`examples/save-conflict.spec.json` は、2つの保存要求の応答が逆順(A→B 送信、B→A 解放)で届いたときに、古い応答が新しい内容を巻き戻さないことを検証します。binding の `mode:"hold"` network fixture が応答を保留し、`expectHeld`/`release` アクションが要求到着順と解放順を決定的に制御します。

```
node fixtures/server.mjs &
node src/cli.ts examples/save-conflict.spec.json --binding examples/save-conflict.naive.binding.json --adapter playwright --out report-naive.json
node src/cli.ts examples/save-conflict.spec.json --binding examples/save-conflict.fixed.binding.json --adapter playwright --out report-fixed.json
```

- naive 版(応答を無条件適用): `implementation: CONFIRMED`。オラクルが `release_a` 後のエディタ生値を読み、期待値(新しい方の具体入力)との不一致を独立証拠(`INDEPENDENT_ORACLE`)として確定します。反例のイベント列 `[send_a, send_b, release_b, release_a]` がそのまま再現手順になります
- fixed 版(rev 比較で古い応答を破棄): `conformance`/`implementation` は `PASS`
- model target は両版で `CONFIRMED`: 仕様が stale 適用を env 分岐として許容しており、`neverTransition` の反例が「この順序で巻き戻り得る」ことを示します。アプリが実際にそう動くかはオラクルが判定します

レポート(`report-naive.json`)には操作列・観測列・期待値/実測値・再実行結果(`evidence.replay`)が記録されるため、spec/binding/fixture と合わせて他の開発者が同じ不具合を再現できます。

## 構成

```
docs/        仕様書と入門ガイド
examples/    仕様 JSON と binding JSON
fixtures/    サンプルアプリ(React / Svelte / Solid / playground / conflict)と配信サーバー
sample/      実際の React 設定フォームサンプル
src/         CLI とエンジン
test/        テスト
.github/     CI(npm ci → Chromium → build:fixtures → npm test → レポート artifact)
design/      設計 (Surv IR)
behavior/    振る舞いの定義 (Surv IR)
```

## 入門

初めて使う場合は [docs/guide_disclosure.md](docs/guide_disclosure.md) を読んでください。仕様、binding、検証の結果の読み方、わざとバグを入れて検出を確かめる手順を順に説明しています。

## テスト

```
npm test
```

Golden Tests(ブラウザー不要)と Playwright acceptance tests(React/Solid/Svelte の disclosure、playground、save-conflict naive/fixed)を実行します。acceptance tests は fixture サーバーを自分で起動します。

設計変更後は `surc check surv.toml`、Behavior IR 変更時は `surc verify surv.toml` を実行してください(AGENTS.md / CLAUDE.md 参照)。
