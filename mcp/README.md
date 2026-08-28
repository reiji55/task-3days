# task-3days MCP サーバー

`tasks.txt` を読み書きする MCP サーバー。Claude / Cowork / Claude Desktop に
**カスタムコネクタ**として繋ぐと、会話からタスクの状態を読んだり更新したりできる。

ビューア（`../index.html`）とは独立している。両方同時に使ってよい。
どちらも同じ `tasks.txt` を GitHub Contents API 経由で読み書きするだけ。

## ツール

| ツール | すること |
|---|---|
| `get_tasks` | タスク一覧を返す。既定は昨日・今日・明日の3日分（`scope: "all"` で全日付） |
| `set_done` | チェックの付け外し。該当行の `[ ]` だけを書き換える |
| `set_memo` | メモの差し替え。空文字を渡すと `memo:` 行ごと消える |

タスクは `get_tasks` が返す `id`（`"2026-08-28#2"` = 日付 + その日の何番目か）で指す。

書き換えは常に「読む → 該当行だけ直す → 書く」で、コメント行・空行・並び順・書式は保持する。
GitHub 側の SHA が食い違えば書かずにエラーを返すので、他所の変更を潰さない。

## 構成

```
api/mcp/[key].js   Vercel Function。URL 末尾が合鍵
lib/handler.js     合鍵の照合と MCP トランスポート（ステートレス）
lib/server.js      ツールの定義
lib/tasks.js       tasks.txt の解析と書き換え（純粋関数）
lib/github.js      GitHub Contents API
test/              node --test で全部走る
```

## 環境変数

Vercel のプロジェクト設定で入れる。**コードにもリポジトリにも書かない。**

| 変数 | 必須 | 中身 |
|---|---|---|
| `GITHUB_TOKEN` | ○ | Fine-grained token。`task-3days` の Contents = Read and write |
| `MCP_KEY` | ○ | 接続 URL の末尾に入る合鍵。長いランダム文字列 |
| `GITHUB_OWNER` | | 既定 `reiji55` |
| `GITHUB_REPO` | | 既定 `task-3days` |
| `GITHUB_BRANCH` | | 既定 `main` |
| `TASKS_PATH` | | 既定 `tasks.txt` |
| `TZ_NAME` | | 既定 `Asia/Tokyo`。「今日」の判定に使う |

## デプロイ

Vercel で **Import Git Repository** → `reiji55/task-3days` →
**Root Directory を `mcp` に設定**。フレームワークは Other のままでよい。

デプロイ後、環境変数を入れて再デプロイ。接続先はこの形になる:

```
https://<プロジェクト名>.vercel.app/api/mcp/<MCP_KEY>
```

この URL を claude.ai の設定 → コネクタ → カスタムコネクタを追加 に貼る。
`MCP_KEY` が合わない URL には `404` を返すので、存在自体が分からない。

## テスト

```
npm install
npm test
```

`test/tasks.test.mjs` は解析と書き換えの純粋ロジック。
`test/protocol.test.mjs` は本物の MCP クライアントを実際のプロトコルで喋らせ、
GitHub だけ差し替えて通しで確認する。

## 注意

このリポジトリは public。**トークンと `MCP_KEY` は絶対にコミットしない。**
どちらも Vercel の環境変数にだけ置く。
