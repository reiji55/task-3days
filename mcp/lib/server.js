// MCP サーバー本体。ツールは3つだけに絞ってある。
// 行の追加・削除などは、スキル側の構想が固まってから足す。

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { parse, writeDone, writeMemo, findTask, snapshot } from './tasks.js';
import { readTasks, writeTasks } from './github.js';

const TZ = process.env.TZ_NAME || 'Asia/Tokyo';

const ok = value => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 1) }] });
const ng = err => ({ isError: true, content: [{ type: 'text', text: String(err.message || err) }] });

export function createServer(io = { readTasks, writeTasks }) {
  const server = new McpServer(
    { name: 'task-3days', version: '1.0.0' },
    { instructions: '3日間タスクビューアの tasks.txt を読み書きする。日付は Asia/Tokyo。' }
  );

  server.registerTool('get_tasks', {
    title: 'タスクを読む',
    description:
      '3日間タスクの一覧を返す。既定は昨日・今日・明日の3日分。' +
      '各タスクの id（例 "2026-08-28#2"）を set_done / set_memo に渡す。',
    inputSchema: {
      scope: z.enum(['window', 'all']).optional()
        .describe('window=昨日今日明日の3日分（既定）／all=ファイル内の全日付')
    }
  }, async ({ scope }) => {
    try {
      const { text } = await io.readTasks();
      const { days } = parse(text);
      return ok(snapshot(days, scope || 'window', TZ));
    } catch (e) { return ng(e); }
  });

  server.registerTool('set_done', {
    title: 'チェックを付け外しする',
    description: 'タスクを完了／未完了にする。tasks.txt の該当行の [ ] だけを書き換える。',
    inputSchema: {
      id: z.string().describe('get_tasks が返した id。例 "2026-08-28#2"'),
      done: z.boolean().describe('true=完了にする／false=未完了に戻す')
    }
  }, async ({ id, done }) => {
    try {
      const { text, sha } = await io.readTasks();
      const { lines, days } = parse(text);
      const task = findTask(days, id);
      if (task.done === done) return ok({ changed: false, task: { id, done }, note: '既にその状態です' });
      writeDone(lines, task.at, done);
      await io.writeTasks(
        lines.join('\n'), sha,
        `tasks: ${done ? '完了' : '未完了に戻す'}（${task.title}）`
      );
      return ok({ changed: true, task: { id, title: task.title, done } });
    } catch (e) { return ng(e); }
  });

  server.registerTool('set_memo', {
    title: 'メモを書き換える',
    description:
      'タスクのメモを差し替える。空文字を渡すとメモ行ごと消える。' +
      '改行を含めると memo: 行が複数本になる。',
    inputSchema: {
      id: z.string().describe('get_tasks が返した id。例 "2026-08-28#2"'),
      memo: z.string().describe('新しいメモ。空文字でメモを削除')
    }
  }, async ({ id, memo }) => {
    try {
      const { text, sha } = await io.readTasks();
      const { lines, days } = parse(text);
      const task = findTask(days, id);
      if ((task.memo || '').trim() === memo.trim()) {
        return ok({ changed: false, task: { id, memo: task.memo || null }, note: '内容が同じです' });
      }
      writeMemo(lines, task, memo);
      await io.writeTasks(
        lines.join('\n'), sha,
        `tasks: メモを${memo.trim() ? '更新' : '削除'}（${task.title}）`
      );
      return ok({ changed: true, task: { id, title: task.title, memo: memo.trim() || null } });
    } catch (e) { return ng(e); }
  });

  return server;
}
