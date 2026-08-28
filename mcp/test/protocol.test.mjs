// 実物の MCP クライアントを本物のプロトコルで喋らせて、
// ハンドラ〜ツール〜ファイル書き換えまでを通しで確かめる。
// GitHub だけ差し替える（io）。

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttp } from 'node:http';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { handle } from '../lib/handler.js';

const ORIG = readFileSync(new URL('../../tasks.txt', import.meta.url), 'utf8');
const KEY = 'test-key-0123456789';

let store, commits, http, base;

function fakeIo() {
  return {
    async readTasks() { return { text: store.text, sha: store.sha }; },
    async writeTasks(text, sha, message) {
      if (sha !== store.sha) throw new Error('別の場所で先に更新されていました');
      store = { text, sha: 'sha' + (commits.length + 1) };
      commits.push({ message, text });
      return store.sha;
    }
  };
}

before(async () => {
  process.env.MCP_KEY = KEY;
  http = createHttp((req, res) => {
    const m = req.url.match(/^\/api\/mcp\/([^/?]+)/);
    const key = m ? decodeURIComponent(m[1]) : '';
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      if (raw) { try { req.body = JSON.parse(raw); } catch { /* 生のまま渡す */ } }
      handle(req, res, key, fakeIo());
    });
  });
  await new Promise(r => http.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${http.address().port}/api/mcp/`;
});

after(() => http.close());

async function connect(key = KEY) {
  store = { text: ORIG, sha: 'sha0' };
  commits = [];
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(base + key)));
  return client;
}

const payload = r => JSON.parse(r.content[0].text);

test('接続してツール一覧が取れる', async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(t => t.name).sort(), ['get_tasks', 'set_done', 'set_memo']);

  const get = tools.find(t => t.name === 'get_tasks');
  assert.ok(get.description.includes('3日'));
  assert.deepEqual(Object.keys(get.inputSchema.properties), ['scope']);

  const done = tools.find(t => t.name === 'set_done');
  assert.deepEqual(done.inputSchema.required.sort(), ['done', 'id']);
  await client.close();
});

test('合鍵が違えば繋がらない', async () => {
  const client = new Client({ name: 'test', version: '1.0.0' });
  await assert.rejects(
    () => client.connect(new StreamableHTTPClientTransport(new URL(base + 'wrong-key'))),
    /404|not found|Error POSTing/i
  );
});

test('get_tasks: 3日分が id 付きで返る', async () => {
  const client = await connect();
  const out = payload(await client.callTool({ name: 'get_tasks', arguments: {} }));
  assert.equal(out.days.length, 3);
  const all = out.days.flatMap(d => d.tasks);
  assert.equal(all.length, 9);
  assert.ok(all.every(t => /^\d{4}-\d{2}-\d{2}#\d+$/.test(t.id)));
  assert.equal(commits.length, 0, '読むだけでコミットしない');
  await client.close();
});

test('get_tasks: scope=all で全日付', async () => {
  const client = await connect();
  const out = payload(await client.callTool({ name: 'get_tasks', arguments: { scope: 'all' } }));
  assert.deepEqual(out.days.map(d => d.date), ['2026-08-27', '2026-08-28', '2026-08-29']);
  await client.close();
});

test('set_done: 完了にすると該当行だけ変わり、戻すと元に戻る', async () => {
  const client = await connect();
  const r = payload(await client.callTool({
    name: 'set_done', arguments: { id: '2026-08-28#2', done: true }
  }));
  assert.equal(r.changed, true);
  assert.equal(r.task.title, 'Project カスタム指示を貼り替える');
  assert.equal(commits.length, 1);
  assert.match(commits[0].message, /完了/);
  assert.match(store.text, /^- \[x\] 終日 \| 前進 \| Vault \| Project カスタム指示を貼り替える$/m);
  assert.equal(store.text.split('\n').length, ORIG.split('\n').length);
  assert.ok(store.text.startsWith('// 書き方は README.md を参照'), 'コメント行が残る');

  await client.callTool({ name: 'set_done', arguments: { id: '2026-08-28#2', done: false } });
  assert.equal(store.text, ORIG, 'バイト単位で元に戻る');
  await client.close();
});

test('set_done: 同じ状態ならコミットしない', async () => {
  const client = await connect();
  const r = payload(await client.callTool({
    name: 'set_done', arguments: { id: '2026-08-27#1', done: true }   // 元から [x]
  }));
  assert.equal(r.changed, false);
  assert.equal(commits.length, 0);
  await client.close();
});

test('set_memo: 追加・差し替え・削除', async () => {
  const client = await connect();

  await client.callTool({ name: 'set_memo', arguments: { id: '2026-08-27#2', memo: '延滞を確認\n次は9月' } });
  assert.ok(store.text.includes('  memo: 延滞を確認\n  memo: 次は9月'));

  await client.callTool({ name: 'set_memo', arguments: { id: '2026-08-27#1', memo: '控えは封筒ごと保管' } });
  assert.ok(store.text.includes('memo: 控えは封筒ごと保管'));
  assert.ok(!store.text.includes('配達証明の控えを保管する'));

  const r = payload(await client.callTool({ name: 'set_memo', arguments: { id: '2026-08-27#1', memo: '' } }));
  assert.equal(r.task.memo, null);
  assert.ok(!store.text.includes('memo: 控えは封筒ごと保管'));
  assert.match(commits.at(-1).message, /メモを削除/);

  // 読み直しても壊れていない
  const out = payload(await client.callTool({ name: 'get_tasks', arguments: { scope: 'all' } }));
  assert.equal(out.days.flatMap(d => d.tasks).length, 9);
  await client.close();
});

test('存在しない id はエラーとして返る（落ちない）', async () => {
  const client = await connect();
  const res = await client.callTool({ name: 'set_done', arguments: { id: '2030-01-01#1', done: true } });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /その日付はありません/);
  assert.equal(commits.length, 0);
  await client.close();
});

test('引数の型が違えば弾かれる', async () => {
  const client = await connect();
  const res = await client.callTool({ name: 'set_done', arguments: { id: '2026-08-28#1', done: 'yes' } });
  assert.equal(res.isError, true);
  assert.equal(commits.length, 0);
  await client.close();
});

test('GitHub 側が落ちてもエラーとして返る', async () => {
  process.env.MCP_KEY = KEY;
  const boom = createHttp((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      if (raw) { try { req.body = JSON.parse(raw); } catch { /* noop */ } }
      handle(req, res, KEY, {
        readTasks: async () => { throw new Error('GITHUB_TOKEN が無効か期限切れです'); },
        writeTasks: async () => { throw new Error('unreachable'); }
      });
    });
  });
  await new Promise(r => boom.listen(0, '127.0.0.1', r));
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${boom.address().port}/api/mcp/${KEY}`)));
  const res = await client.callTool({ name: 'get_tasks', arguments: {} });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /GITHUB_TOKEN/);
  await client.close();
  boom.close();
});
