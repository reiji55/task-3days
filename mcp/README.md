# task-3days MCP サーバー

`tasks.txt` を読み書きするサーバー。口が2つある。

1. **MCP**（`/api/mcp/<合鍵>`）… Claude / Cowork / Claude Desktop に
   **カスタムコネクタ**として繋ぐと、会話からタスクを読み書きできる
2. **HTTP**（`/api/tasks`）… ビューア（`../index.html`）が叩く。暗証番号で守る

**GITHUB_TOKEN はここにしか無い。** ブラウザにも会話にもリポジトリにも出ない。
ビューアが持つのは短い暗証番号だけなので、端末から消えても入れ直しが軽い。

## ツール

| ツール | すること |
|---|---|
| `get_tasks` | 一覧を返す。既定は昨日・今日・明日の3日分（`scope: "all"` で全日付） |
| `set_done` | チェックの付け外し。複数まとめて渡せる |
| `set_memo` | メモの差し替え。空文字を渡すと `memo:` 行ごと消える |
| `add_tasks` | タスクを足す。日付の見出しがなければ作る。`replace: true` でその日を丸ごと入れ替え |
| `update_task` | 時間帯・型・プロジェクト・タスク名を直す。渡さなかった欄はそのまま |
| `move_tasks` | 別の日へ移す（繰り越し）。チェックもメモも持っていく |
| `remove_tasks` | 消す。メモの行も一緒に消える |

タスクは `get_tasks` が返す `id`（`"2026-08-28#2"` = 日付 + その日の何番目か）で指す。
番号は読むたびに振り直されるので、**書き換える前に必ず `get_tasks` を呼ぶ。**

### 決めごと

- **1回の呼び出し = 1コミット。** 複数まとめられるものは配列で渡すとコミットも1本で済む
- 書き換えは常に「読む → 該当行だけ直す → 書く」。**コメント行・空行・並び順・書式は保持する**
- GitHub 側の SHA が食い違えば書かずにエラー。ビューアからの編集と衝突しても潰さない
- 何も変わらない場合は書かない（`changed: false` を返す）
- 終わったタスクは消さずにチェックを付ける。`remove_tasks` は間違えて入れたときだけ

### 朝の入れ替え

```
get_tasks                                   … 今の状態と id を見る
move_tasks  ids=[今日の残り] date=明日        … 終わらなかった分を繰り越す
add_tasks   date=明日 tasks=[...]            … 新しい分を足す
```

`add_tasks` に `replace: true` を付けると、その日の既存タスクを消してから入れる。

## 構成

```
api/mcp/[key].js   MCP の入口。URL 末尾が合鍵
api/tasks.js       ビューアの入口。暗証番号で守る
lib/tasks-api.js   /api/tasks の中身（CORS・認証・読み書き）
lib/handler.js     合鍵の照合と MCP トランスポート（ステートレス）
lib/server.js      ツールの定義
lib/tasks.js       tasks.txt の解析と書き換え（純粋関数）
lib/github.js      GitHub Contents API
public/index.html  / に置く案内ページ。動作には無関係
test/              node --test で全部走る
```

## 環境変数

Vercel のプロジェクト設定で入れる。**コードにもリポジトリにも書かない。**

| 変数 | 必須 | 中身 |
|---|---|---|
| `GITHUB_TOKEN` | ○ | Fine-grained token。`task-3days` の Contents = Read and write |
| `MCP_KEY` | ○ | MCP の接続 URL の末尾に入る合鍵。長いランダム文字列 |
| `EDIT_PIN` | ○ | ビューアの暗証番号。短い数字でよい |
| `ALLOW_ORIGIN` | | ビューアのオリジン。既定 `https://reiji55.github.io` |
| `GITHUB_OWNER` | | 既定 `reiji55` |
| `GITHUB_REPO` | | 既定 `task-3days` |
| `GITHUB_BRANCH` | | 既定 `main` |
| `TASKS_PATH` | | 既定 `tasks.txt` |
| `TZ_NAME` | | 既定 `Asia/Tokyo`。「今日」の判定に使う |

## デプロイ

Vercel で **Import Git Repository** → `reiji55/task-3days`。
**Root Directory を `mcp` に**、Framework Preset は `Other`、Build / Output は空のまま。
環境変数を入れてから Deploy する。

以降は **`main` への push で自動デプロイ**される。

### 詰まりやすいところ

- **Git を後から繋いだ場合、その時点では何もデプロイされない。** 次の push で初めて走る。
  Overview に「No Production Deployment」と出ていて Deployments が空なら、これ。
  適当なコミットを push すれば動き出す。
- **Deployments が0件だと Redeploy ボタンは出ない。** 「やり直す元」が無いため。
- Root Directory が `mcp` でないと、リポジトリ直下（ビューア）が配信され
  `/api/mcp/...` は 404 になる。あとから Settings → Build and Deployment で直せる。
- 環境変数は入れただけでは効かない。入れたあとに再デプロイが要る。
- `/` を開いて `404: NOT_FOUND` なら、`public/index.html` が配信されていない。
  Root Directory が `mcp` でないか、Output Directory を明示していないか。
  API だけなら 404 のままでも動作には影響しない。

### 接続先

```
https://<プロジェクト名>.vercel.app/api/mcp/<MCP_KEY>
```

この URL を claude.ai の設定 → コネクタ → カスタムコネクタを追加 に貼る。
`MCP_KEY` が合わない URL には `404` を返すので、存在自体が分からない。

疎通だけ見るなら:

```bash
curl -sS -X POST '<上の URL>' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'
```

`serverInfo` が返れば繋がっている。

## テスト

```
npm install
npm test
```

`test/tasks.test.mjs` は解析、`test/edit.test.mjs` は書き換えの純粋ロジック。
`test/protocol.test.mjs` は本物の MCP クライアントを実際のプロトコルで喋らせ、
GitHub だけ差し替えて通しで確認する。
`test/http.test.mjs` は `/api/tasks` を実際の HTTP と fetch で叩き、
認証・CORS・競合・入力検証を確かめる。

## 注意

このリポジトリは public。**トークン・`MCP_KEY`・`EDIT_PIN` は絶対にコミットしない。**
すべて Vercel の環境変数にだけ置く。

`EDIT_PIN` は短いので総当たりが効く。`/api/tasks` は外れるたびに待たせて
速度を落としているが、それだけ。書き換えられて困るものは置かない。
