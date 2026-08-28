// MCP サーバー本体。
// どのツールも「読む → 直す → 書く」の1往復で、1回の呼び出しが1コミットになる。
// 複数まとめて動かせるものは配列で受けて、コミットを1本にまとめる。

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  parse, snapshot, setDone, setMemo, updateTask, addTasks, removeTasks, moveTasks
} from './tasks.js';
import { readTasks, writeTasks } from './github.js';

const TZ = process.env.TZ_NAME || 'Asia/Tokyo';

const ok = value => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 1) }] });
const ng = err => ({ isError: true, content: [{ type: 'text', text: String(err.message || err) }] });

const ID = z.string().describe('get_tasks が返した id。例 "2026-08-28#2"');
const IDS = z.array(z.string()).min(1).describe('id の配列。1件でも配列で渡す');
const DATE = z.string().describe('YYYY-MM-DD。例 "2026-08-29"');

const TASK_INPUT = z.object({
  title: z.string().describe('タスク名。必須'),
  time: z.string().optional().describe('時間帯。"20:00-21:00" / "終日" / "午前" など'),
  type: z.string().optional().describe('型。"前進" または "ルーチン"'),
  project: z.string().optional().describe('プロジェクト名'),
  memo: z.string().optional().describe('メモ。改行で複数行'),
  done: z.boolean().optional().describe('最初から完了扱いにする場合のみ true')
});

export function createServer(io = { readTasks, writeTasks }) {
  const server = new McpServer(
    { name: 'task-3days', version: '2.0.0' },
    {
      instructions:
        '3日間タスクビューア（https://reiji55.github.io/task-3days/）の tasks.txt を読み書きする。' +
        '日付は Asia/Tokyo。まず get_tasks で現状と id を取ってから、他のツールを呼ぶこと。' +
        '書き換えは1回ごとに GitHub へ1コミット。'
    }
  );

  // 読む → 直す → 書く をまとめる。fn は text を受けて { text, ...報告 } を返す。
  const edit = (fn, message) => async args => {
    try {
      const { text, sha } = await io.readTasks();
      const out = fn(text, args);
      const { text: next, ...report } = out;
      if (next === text) return ok({ ...report, changed: false, note: '変更ありません' });
      await io.writeTasks(next, sha, message(out, args));
      return ok({ ...report, changed: true });
    } catch (e) { return ng(e); }
  };

  server.registerTool('get_tasks', {
    title: 'タスクを読む',
    description:
      'タスク一覧を返す。既定は昨日・今日・明日の3日分。' +
      '返ってくる id を他のツールに渡す。書き換える前に必ずこれを呼ぶ。',
    inputSchema: {
      scope: z.enum(['window', 'all']).optional()
        .describe('window=昨日今日明日の3日分（既定）／all=ファイル内の全日付')
    }
  }, async ({ scope }) => {
    try {
      const { text } = await io.readTasks();
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
      '終わらなかった今日の分を明日へ送るときに使う。',
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

  return server;
}
