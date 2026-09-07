// MCP サーバー本体。
// どのツールも「読む → 直す → 書く」の1往復で、1回の呼び出しが1コミットになる。
// 複数まとめて動かせるものは配列で受けて、コミットを1本にまとめる。

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  parse, snapshot, setDone, setMemo, updateTask, addTasks, removeTasks, moveTasks,
  pruneEmptyDays
} from './tasks.js';
import { buildWeek, sameContent, summary as weekSummary } from './week.js';
import { readTasks, writeTasks, readWeek, writeWeek } from './github.js';

const TZ = process.env.TZ_NAME || 'Asia/Tokyo';

const ok = value => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 1) }] });
const ng = err => ({ isError: true, content: [{ type: 'text', text: String(err.message || err) }] });

const ID = z.string().describe('get_tasks が返した id。例 "2026-08-28#2" / "anytime#1"');
const IDS = z.array(z.string()).min(1).describe('id の配列。1件でも配列で渡す');
const DATE = z.string().describe(
  'YYYY-MM-DD。例 "2026-08-29"。' +
  '日付を決めずに置いておくものは "anytime"（ファイル上の「# いつでも」）');

const TASK_INPUT = z.object({
  title: z.string().describe('タスク名。必須'),
  time: z.string().optional().describe('時間帯。"20:00-21:00" / "終日" / "午前" など'),
  type: z.string().optional().describe('型。"前進" または "ルーチン"'),
  project: z.string().optional().describe('プロジェクト名'),
  memo: z.string().optional().describe('メモ。改行で複数行'),
  done: z.boolean().optional().describe('最初から完了扱いにする場合のみ true')
});

export function createServer(io = {}) {
  // 既定は GitHub。テストは必要な口だけ差し替えればよい
  const gh = { readTasks, writeTasks, readWeek, writeWeek, ...io };

  const server = new McpServer(
    { name: 'task-3days', version: '2.0.0' },
    {
      instructions:
        '3日間タスクビューア（https://reiji55.github.io/task-3days/）の中身を読み書きする。' +
        'tasks.txt が作業台（3日分＋「いつでも」）、week.json が週の時間割' +
        '（Google カレンダーの写しで、見るだけの資料）。' +
        '日付は Asia/Tokyo。まず get_tasks / get_week で現状と id を取ってから、他のツールを呼ぶこと。' +
        '書き換えは1回ごとに GitHub へ1コミット。'
    }
  );

  // 読む → 直す → 書く をまとめる。fn は text を受けて { text, ...報告 } を返す。
  const edit = (fn, message) => async args => {
    try {
      const { text, sha } = await gh.readTasks();
      const out = fn(text, args);
      const { text: edited, ...report } = out;
      // 空になった過去の日付の見出しは、この保存に相乗りさせて片付ける
      const { text: next, pruned } = pruneEmptyDays(edited, TZ);
      if (pruned.length) report.pruned = pruned;
      if (next === text) return ok({ ...report, changed: false, note: '変更ありません' });
      await gh.writeTasks(next, sha, message(out, args));
      return ok({ ...report, changed: true });
    } catch (e) { return ng(e); }
  };

  server.registerTool('get_tasks', {
    title: 'タスクを読む',
    description:
      'タスク一覧を返す。既定は昨日・今日・明日の3日分。' +
      '日付に紐づかない「いつでも」の分は、scope に関わらず anytime として必ず返る。' +
      '返ってくる id を他のツールに渡す。書き換える前に必ずこれを呼ぶ。',
    inputSchema: {
      scope: z.enum(['window', 'all']).optional()
        .describe('window=昨日今日明日の3日分（既定）／all=ファイル内の全日付')
    }
  }, async ({ scope }) => {
    try {
      const { text } = await gh.readTasks();
      return ok(snapshot(parse(text).days, scope || 'window', TZ));
    } catch (e) { return ng(e); }
  });

  server.registerTool('set_done', {
    title: 'チェックを付け外しする',
    description:
      'タスクを完了／未完了にする。複数まとめて渡せる。' +
      '該当行の [ ] だけを書き換えるので、他の記述は一切変わらない。',
    inputSchema: {
      ids: IDS,
      done: z.boolean().describe('true=完了にする／false=未完了に戻す')
    }
  }, edit(
    (text, { ids, done }) => setDone(text, ids, done),
    (out, { done }) => `tasks: ${out.updated.length}件を${done ? '完了' : '未完了に戻す'}`
  ));

  server.registerTool('set_memo', {
    title: 'メモを書き換える',
    description:
      'タスクのメモを差し替える。空文字を渡すとメモ行ごと消える。' +
      '改行を含めると memo: 行が複数本になる。',
    inputSchema: {
      id: ID,
      memo: z.string().describe('新しいメモ。空文字でメモを削除')
    }
  }, edit(
    (text, { id, memo }) => setMemo(text, id, memo),
    (out, { memo }) => `tasks: メモを${String(memo).trim() ? '更新' : '削除'}（${out.task.title}）`
  ));

  server.registerTool('add_tasks', {
    title: 'タスクを足す',
    description:
      '指定した日付にタスクを追加する。日付の見出しがなければ作る。' +
      'date に "anytime" を渡すと「いつでも」に入る（いつやるか決めていないもの）。' +
      'replace=true にするとその日の既存タスクを全部置き換える（朝の入れ替え用）。' +
      '同じ内容を二重に足さないよう、先に get_tasks で確認すること。',
    inputSchema: {
      date: DATE,
      tasks: z.array(TASK_INPUT).min(1).describe('追加するタスク。まとめて渡すと1コミットで済む'),
      position: z.enum(['end', 'start']).optional().describe('end=その日の最後（既定）／start=先頭'),
      replace: z.boolean().optional().describe('true=その日の既存タスクを全部消してから入れる')
    }
  }, edit(
    (text, { date, tasks, position, replace }) => addTasks(text, date, tasks, { position, replace }),
    out => `tasks: ${out.date} に${out.replaced ? '入れ替えで' : ''}${out.added.length}件追加`
  ));

  server.registerTool('update_task', {
    title: 'タスクの中身を直す',
    description:
      '時間帯・型・プロジェクト・タスク名を書き換える。渡さなかった欄はそのまま。' +
      '空文字を渡すとその欄を空にする。チェックは set_done、メモは set_memo。',
    inputSchema: {
      id: ID,
      title: z.string().optional().describe('新しいタスク名'),
      time: z.string().optional().describe('新しい時間帯。空文字で消す'),
      type: z.string().optional().describe('新しい型。空文字で消す'),
      project: z.string().optional().describe('新しいプロジェクト名。空文字で消す')
    }
  }, edit(
    (text, { id, ...patch }) => updateTask(text, id, patch),
    out => `tasks: 内容を更新（${out.task.title}）`
  ));

  server.registerTool('move_tasks', {
    title: 'タスクを別の日へ移す',
    description:
      'タスクを別の日付へ移す（繰り越し）。チェック・メモ・各欄はそのまま持っていく。' +
      '終わらなかった今日の分を明日へ送るときや、' +
      '「いつでも」（date="anytime"）と特定の日付の間を行き来させるときに使う。',
    inputSchema: {
      ids: IDS,
      date: DATE,
      position: z.enum(['end', 'start']).optional().describe('移動先での位置。既定は end')
    }
  }, edit(
    (text, { ids, date, position }) => moveTasks(text, ids, date, position),
    out => `tasks: ${out.moved.length}件を ${out.to} へ移動`
  ));

  server.registerTool('remove_tasks', {
    title: 'タスクを消す',
    description:
      'タスクを削除する。メモの行も一緒に消える。' +
      '終わったタスクは消さずにチェックを付けるのが普通。消すのは間違えて入れたときだけ。',
    inputSchema: { ids: IDS }
  }, edit(
    (text, { ids }) => removeTasks(text, ids),
    out => `tasks: ${out.removed.length}件を削除`
  ));

  /* ---------- 週間タイムテーブル（week.json） ---------- */

  server.registerTool('get_week', {
    title: '週の時間割を読む',
    description:
      'ビューアの「週」に出ている週間タイムテーブルを返す。Google カレンダーの写しで、' +
      '月曜始まりの7日分を日ごとにまとめて返す。' +
      'updated がいつの写しかを示し、古ければ stale に何週前かが入る。' +
      '画面で付けた印が status に入る（done=やった／miss=やらなかった）。' +
      'miss を付けたものは missed にまとめて返る。' +
      '「やらなかった枠をカレンダーから消して」と頼まれたら、これを見て対象を出す。' +
      'ただし消す前に必ず一覧を見せて確認を取ること。' +
      'カレンダーそのものを見たいときはカレンダー側のツールを使うこと。',
    inputSchema: {}
  }, async () => {
    try {
      const { text } = await gh.readWeek();
      return ok(weekSummary(text, TZ));
    } catch (e) { return ng(e); }
  });

  server.registerTool('set_week', {
    title: '週の時間割を差し替える',
    description:
      'week.json を丸ごと書き換える。ビューアの「週」がこれを読む。' +
      'Google カレンダーから取った1週間分の予定をそのまま渡す（追記ではなく全部入れ替え）。' +
      'week はその週のどこかの日付でよく、月曜に丸める。範囲外の予定は捨てる。' +
      '毎週月曜の朝にこれを呼んで写しを入れ替える運用。',
    inputSchema: {
      week: z.string().describe('対象の週。YYYY-MM-DD。週内のどの日でも月曜に丸める'),
      events: z.array(z.object({
        summary: z.string().describe('予定の名前。カレンダーの summary をそのまま'),
        start: z.string().describe('開始。ISO8601。例 "2026-09-07T07:00:00+09:00"'),
        end: z.string().describe('終了。ISO8601'),
        location: z.string().optional().describe('場所'),
        calendar: z.string().optional().describe('どのカレンダーの予定か（表示名）'),
        color: z.string().optional().describe('#rrggbb。指定しなければ名前ごとに自動で振る'),
        status: z.enum(['done', 'miss']).optional()
          .describe('done=やった／miss=やらなかった。渡さなければ前の写しから引き継ぐ')
      })).describe('その週の全予定。深夜またぎはそのまま渡してよい（画面側で切り分ける）'),
      start_hour: z.number().optional().describe('縦軸の始まり。既定 5'),
      end_hour: z.number().optional().describe('縦軸の終わり。26 = 翌2時。既定 26'),
      dim: z.array(z.string()).optional()
        .describe('薄く表示する予定の名前。既定 ["睡眠","生活時間"]。空配列で全部くっきり')
    }
  }, async args => {
    try {
      const cur = await gh.readWeek().catch(() => ({ text: '', sha: undefined }));
      // 写しを取り直しても、画面で付けた ⭕️❌ は引き継ぐ
      const built = buildWeek(args, { tz: TZ, keepStatus: cur.text });
      // 見に行っただけで中身が同じなら書かない（updated の差だけでは動かさない）
      if (sameContent(built.json, cur.text)) {
        return ok({ week: built.week, events: built.kept, changed: false, note: '変更ありません' });
      }
      await gh.writeWeek(built.json, cur.sha, `week: ${built.week} の週を更新（${built.kept}件）`);
      return ok({ week: built.week, events: built.kept, dropped: built.dropped, changed: true });
    } catch (e) { return ng(e); }
  });

  return server;
}
