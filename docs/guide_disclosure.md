# Tidal 入門: 開閉パネル (disclosure) で学ぶ

フロントエンドの経験がなくても、このガイドの順で読むと Tidal の使い方と仕組みがつかめます。題材は「ボタンで開閉するパネルとメモ欄」です。

## 0. 準備

```
npm install
npm run build:fixtures          # Svelte 版を含む fixture をビルド
node fixtures/server.mjs 4173   # 別ターミナルで起動したままにする
```

サーバーは `http://localhost:4173` でアプリを配信します。検証はこのサーバーに接続して行います。

## 1. 仕様を読む: `examples/disclosure.spec.json`

仕様は「状態」「イベント」「遷移」「性質」の 4 つでできています。

- **状態 (`states`)**
  - `panel`: `closed` か `open` の 2 値。
  - `note`: `empty` か `fed` の 2 値(メモ欄に入力があるか)。
- **初期状態 (`initialState`)**: パネルは `closed`、メモは `empty`。
- **イベント (`events`)**: ユーザーの操作(`open`, `close`, `edit_note`)と、ブラウザの操作(`reload`)です。
- **遷移 (`transitions`)**: 「どの状態のとき、どのイベントで、どの状態に変わるか」を書きます。
  - `t_open`: closed のとき open で、open になる。
  - `t_close`: open のとき close で、closed になる。
  - `t_edit_note`: メモ欄に入力すると `fed` になる。
  - `t_reload`: どの状態でも reload し、状態は変わらない。
- **性質 (`properties`)**: 常に守られるべき条件です。
  - `only_close_closes_panel`: close 以外で開いたパネルが閉じないこと。
  - `closed_can_be_opened`: 閉じたパネルは開けること。
  - `open_is_escapable_by_user`: 開いたパネルは、ユーザーの操作で閉じられること。
  - `note_survives_reload`: 入力済みのメモが、リロードで消えないこと。

ポイント: 仕様には React も Svelte も Solid も出てきません。「ユーザーが見て何が起きるべきか」だけを書いています。

## 2. アプリを見る: `fixtures/apps/disclosure/react/index.html`

ブラウザで `http://localhost:4173/fixtures/apps/disclosure/react/index.html` を開いて試してください。

- ボタンを押すと表示が `open` / `closed` に切り替わります。
- メモ欄に入力すると、状態が `fed` になります。
- ページを再読み込みしても、開いた状態とメモの内容が残ります。

この「再読み込みで残る」動きが、仕様の `t_reload` と `note_survives_reload` の意味です。

同じ動きを Svelte(`fixtures/apps/disclosure/svelte/`)と Solid(`fixtures/apps/disclosure/solid/`)でも実装しています。仕様は 3 つで共通です。

## 3. binding: 仕様とアプリをつなぐ

binding は、仕様のイベントを画面の操作に対応づけるファイルです。

- `examples/disclosure.binding.json`: 3 フレームワーク共通の定義。
  - `events`: 各イベントで行う操作。例: `open` は `data-testid="toggle-button"` のボタンを click する。
  - `observe`: 画面から状態を読み取る方法。例: `data-testid="panel-status"` の文字 (`open` / `closed`) を読む。
- `examples/disclosure.react.binding.json` などフレームワーク別のファイル: `extends` で共通定義を読み込み、`baseUrl` だけを書きます。

```json
{
  "extends": "./disclosure.binding.json",
  "baseUrl": "http://localhost:4173/fixtures/apps/disclosure/react/index.html"
}
```

`extends` のパスは、そのファイルからの相対パスです。`data-testid` は HTML に付けた目印です。index.html の中で `data-testid="toggle-button"` を探すと、対応が分かります。

## 4. 検証を実行する

モデル検査(仕様だけを調べる):

```
node src/cli.ts examples/disclosure.spec.json --targets model
```

ブラウザでの検証(アプリを実際に操作する)。3 フレームワークとも同じ仕様で実行できます。

```
node src/cli.ts examples/disclosure.spec.json --binding examples/disclosure.react.binding.json --adapter playwright --out report.json
node src/cli.ts examples/disclosure.spec.json --binding examples/disclosure.svelte.binding.json --adapter playwright --out report.json
node src/cli.ts examples/disclosure.spec.json --binding examples/disclosure.solid.binding.json --adapter playwright --out report.json
```

結果の見方:

| 表示 | 意味 |
|---|---|
| `PASS` (exit 0) | 仕様どおり動いた |
| `INCONCLUSIVE` (exit 2) | 仕様と観測がずれた。アプリのバグと確定はしていない |

`report.json` には、どの操作列でどの観測が出たかが書かれます。不一致が出た場合は、再実行で何回再現したかも記録されます。

## 5. わざと壊して、検出を確かめる

Tidal が本当にバグを見つけるか、自分で試せます。

1. `fixtures/apps/disclosure/react/index.html` をコピーして、`fixtures/apps/disclosure/_bugs/reset/index.html` を作る。
2. コピー先で、次の 1 行を変える。

   変更前: `const [open, setOpen] = useState(() => localStorage.getItem(KEY) === "open");`
   変更後: `const [open, setOpen] = useState(false);`

   これで「再読み込みすると必ず閉じる」バグになります。
3. `examples/disclosure.react.binding.json` をコピーして `examples/disclosure.reset.binding.json` を作り、`baseUrl` を `.../_bugs/reset/index.html` に書き換える。`extends` のパスは変えずに残してください。
4. step 4 と同じ形式で、`examples/disclosure.reset.binding.json` を指定して検証する。

期待される結果: `conformance` が `INCONCLUSIVE` になり、反例が出ます。確認時の反例は `["open", "reload"]` と `["open", "edit_note", "reload"]` でした。どちらも「開いてから再読み込みすると、仕様では open のままのはずなのに閉じている」という意味です。

試し終わったら `_bugs` ディレクトリと `examples/disclosure.reset.binding.json` は削除してください。

## 6. 用語の対応

| 用語 | 日常の言葉での意味 |
|---|---|
| 状態 | 画面が今どうなっているか |
| イベント | ユーザーや環境がしたこと |
| 遷移 | 状態がどう変わるか |
| 性質 | 常に守られるべきルール |
| binding | 仕様の言葉を、画面の操作に翻訳する表 |
| 反例 | ルールが破れた操作の手順 |
