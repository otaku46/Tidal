# Tidal

Web アプリの UX の振る舞いを宣言的な仕様として書き、その仕様を実装が満たすかを検査するツールです。

仕様は「状態」「イベント」「遷移」「性質」で記述します。Tidal はそこから操作列を生成し、次の 3 種類を分けて検査します。

1. **モデル検査**: 仕様だけを探索し、性質が成り立つかを調べる。
2. **適合性検査**: モデルの予測と、ブラウザで観測した状態を比べる。
3. **具体値検証**: 抽象状態では見えないデータの損失を、独立したオラクルで調べる(計画段階)。

モデル検査が PASS でも、アプリの正しさを証明するものではありません。検査できるのは仕様に書いた性質と遷移だけです。

仕様の詳細は [docs/spec_tidal.md](docs/spec_tidal.md) を参照してください(日本語)。

## 状態

初期段階です。対象は React / Svelte / Solid の開閉パネル(disclosure)のサンプルに限られます。実アプリでの検証はまだありません。

## 必要環境

- Node.js 22.18 以上
- Playwright(ブラウザ検証に使用)。`package.json` には依存として記載していないため、導入方法は要確認です。

## セットアップ

```
npm install
npm run build:fixtures          # Svelte 版のビルド
node fixtures/server.mjs 4173   # サンプルアプリを配信(別ターミナルで起動したままにする)
```

## 使い方

モデル検査(仕様のみ):

```
node src/cli.ts examples/disclosure.spec.json --targets model
```

ブラウザで検証(フレームワークごとに binding を指定):

```
node src/cli.ts examples/disclosure.spec.json --binding examples/disclosure.react.binding.json --adapter playwright --out report.json
node src/cli.ts examples/disclosure.spec.json --binding examples/disclosure.svelte.binding.json --adapter playwright --out report.json
node src/cli.ts examples/disclosure.spec.json --binding examples/disclosure.solid.binding.json --adapter playwright --out report.json
```

主なオプション:

| オプション | 内容 |
|---|---|
| `--targets` | 検査対象。`model,conformance,implementation` のカンマ区切り |
| `--binding` | 仕様のイベントを画面の操作に対応づける JSON |
| `--adapter` | 実行するアダプター(`playwright`) |
| `--out` | 機械可読レポートの出力先(JSON) |
| `--minimize n` | 反例の最小化で試す上限回数(既定 8) |
| `--replay n` | 不一致の再現確認を行う回数 |

### 別サンプル: profile 設定フォーム

`sample/react/index.html` は、未保存変更・保存中・保存失敗・破棄確認・リロードを扱う React のサンプルです。仕様と binding を使って、同じ CLI で検証できます。

```
node src/cli.ts examples/profile.spec.json --targets model
node src/cli.ts examples/profile.spec.json --binding examples/profile.react.binding.json --adapter playwright --out report.json
```

具体値オラクル `saved_value_survives_reload` が、保存した値がリロード後も残ることを個別に確認します。観測状態の不一致とは分けて報告されます。

## 結果

| 判定 | 意味 |
|---|---|
| `PASS` (exit 0) | 仕様どおり動いた |
| `INCONCLUSIVE` (exit 2) | 仕様と観測がずれた。アプリのバグとは確定していない |

観測の不一致だけでは実装のバグを確定しません。レポートには、どの操作列で、どの観測が出て、何回中何回再現したかが記録されます。

## 構成

```
docs/        仕様書と入門ガイド
examples/    仕様 JSON と binding JSON
fixtures/    サンプルアプリ(React / Svelte / Solid)と配信サーバー
src/         CLI とエンジン
test/        テスト
design/      設計 (Surv IR)
behavior/    振る舞いの定義 (Surv IR)
```

## 入門

初めて使う場合は [docs/guide_disclosure.md](docs/guide_disclosure.md) を読んでください。仕様、binding、検証の結果の読み方、わざとバグを入れて検出を確かめる手順を順に説明しています。

## テスト

```
npm test
```
