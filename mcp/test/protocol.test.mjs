// 実物の MCP クライアントを本物のプロトコルで喋らせて、
// ハンドラ〜ツール〜ファイル書き換えまでを通しで確かめる。GitHub だけ差し替える。
//
// テストごとにサーバーもファイルの状態も作り直す。共有すると互いに干渉するし、
// keep-alive の接続が残ってプロセスが終わらなくなる。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttp } from 'node:http';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { handle } from '../lib/handler.js';
import { parse } from '../lib/tasks.js';

const ORIG = readFileSync(new URL('./fixture.txt', import.meta.url), 'utf8');
const KEY = 'test-key-0123456789';
process.env.MCP_KEY = KEY;

/** tasks.txt を持っているつもりの偽 GitHub。テスト1件につき1つ。 */
function fixture() {
  const state = {
    store: { text: ORIG, sha: 'sha0' },
    commits: [],
    get text() { return state.store.text; },
    titles() { return [...parse(state.store.text).days.values()].flat().map(t => t.title); },
    days() { return parse(state.store.text).days; }
  };
  state.io = () => ({
    async readTasks() { return { ...state.store }; },
    async writeTasks(text, sha, message) {
      if (sha !== state.store.sha) throw new Error('別の場所で先に更新されていました');
      state.store = { text, sha: 'sha' + (state.commits.length + 1) };
      state.commits.push({ message, text });
      return state.store.sha;
    }
  });
  return state;
}

/** io を載せた HTTP サーバー。listen は呼び出し側で。 */
function serve(io, { passKey = true, parseBody = true } = {}) {
  return createHttp((req, res) => {
    const m = req.url.match(/^\/api\/mcp\/([^/?]+)/);
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      if (raw) {
        if (parseBody) { try { req.body = JSON.parse(raw); } catch { req.body = raw; } }
        else req.body = raw;              // 解析しないホストの真似
      }
      handle(req, res, passKey ? (m ? decodeURIComponent(m[1]) : '') : undefined, io());
    });
  });
}

/** サーバーを立て、繋ぎ、fn を走らせ、必ず後始末する。 */
async function withClient(io, fn, { key = KEY, opts } = {}) {
  const srv = serve(io, opts);
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const url = new URL(`http://127.0.0.1:${srv.address().port}/api/mcp/${key}`);
  const client = new Client({ name: 'test', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(url));
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
    srv.closeAllConnections?.();
    srv.close();
  }
}

/** 繋がらないことを確かめる用。 */
async function expectNoConnect(io, key) {
  const srv = serve(io);
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const url = new URL(`http://127.0.0.1:${srv.address().port}/api/mcp/${key}`);
  const client = new Client({ name: 'test', version: '1.0.0' });
  try {
    await assert.rejects(() => client.connect(new StreamableHTTPClientTransport(url)));
  } finally {
    await client.close().catch(() => {});
    srv.closeAllConnections?.();
    srv.close();
  }
}

const payload = r => JSON.parse(r.content[0].text);
const call = (c, name, args = {}) => c.callTool({ name, arguments: args });

test('接続してツール一覧が取れる', async () => {
  await withClient(fixture().io, async client => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(t => t.name).sort(), [
      'add_tasks', 'get_tasks', 'move_tasks', 'remove_tasks', 'set_done', 'set_memo', 'update_task'
    ]);
    for (const t of tools) {
      assert.ok(t.description && t.description.length > 10, t.name);
      assert.equal(t.inputSchema.type, 'object', t.name);
    }
    assert.deepEqual(tools.find(t => t.name === 'set_done').inputSchema.required.sort(), ['done', 'ids']);
    assert.deepEqual(tools.find(t => t.name === 'add_tasks').inputSchema.required.sort(), ['date', 'tasks']);
  });
});

test('合鍵が違えば繋がらない', async () => {
  await expectNoConnect(fixture().io, 'wrong-key');
});

test('get_tasks: 3日の窓と全件が返り、コミットしない', async () => {
  const f = fixture();
  await withClient(f.io, async client => {
    // 窓は実行日に対する昨日・今日・明日。中身は日によって変わるので、形だけ見る
    const win = payload(await call(client, 'get_tasks'));
    assert.equal(win.days.length, 3);
    assert.deepEqual(win.days.map(d => d.rel), ['昨日', '今日', '明日']);
    assert.equal(win.days[1].date, win.today);
    assert.ok(win.days.every(d => Array.isArray(d.tasks)));

    // 中身は scope=all で見る（実行日に左右されない）
    const every = payload(await call(client, 'get_tasks', { scope: 'all' }));
    assert.deepEqual(every.days.map(d => d.date), ['2026-08-27', '2026-08-28', '2026-08-29']);
    const all = every.days.flatMap(d => d.tasks);
    assert.equal(all.length, 9);
    assert.ok(all.every(t => /^\d{4}-\d{2}-\d{2}#\d+$/.test(t.id)));
  });
  assert.equal(f.commits.length, 0, '読むだけではコミットしない');
  assert.equal(f.text, ORIG);
});

test('set_done: まとめて1コミット、戻すと元通り', async () => {
  const f = fixture();
  await withClient(f.io, async client => {
    const r = payload(await call(client, 'set_done', { ids: ['2026-08-28#1', '2026-08-28#3'], done: true }));
    assert.equal(r.changed, true);
    assert.equal(f.commits.length, 1, '2件でもコミットは1本');
    assert.equal((f.text.match(/\[x\]/g) || []).length, 4);
    assert.equal(f.text.split('\n').length, ORIG.split('\n').length);

    await call(client, 'set_done', { ids: ['2026-08-28#1', '2026-08-28#3'], done: false });
  });
  assert.equal(f.text, ORIG, 'バイト単位で元に戻る');
});

test('set_done: 全部が既にその状態ならコミットしない', async () => {
  const f = fixture();
  await withClient(f.io, async client => {
    const r = payload(await call(client, 'set_done', { ids: ['2026-08-27#1'], done: true }));
    assert.equal(r.changed, false);
  });
  assert.equal(f.commits.length, 0);
});

test('set_memo: 追加・差し替え・削除', async () => {
  const f = fixture();
  await withClient(f.io, async client => {
    await call(client, 'set_memo', { id: '2026-08-27#2', memo: '延滞を確認\n次は9月' });
    assert.ok(f.text.includes('  memo: 延滞を確認\n  memo: 次は9月'));

    await call(client, 'set_memo', { id: '2026-08-27#1', memo: '控えは封筒ごと保管' });
    assert.ok(!f.text.includes('配達証明の控えを保管する'));

    const r = payload(await call(client, 'set_memo', { id: '2026-08-27#1', memo: '' }));
    assert.equal(r.changed, true);
  });
  assert.match(f.commits.at(-1).message, /メモを削除/);
  assert.equal(f.titles().length, 9);
});

test('add_tasks: まとめて足せて、新しい日付は見出しごとできる', async () => {
  const f = fixture();
  await withClient(f.io, async client => {
    const r = payload(await call(client, 'add_tasks', {
      date: '2026-08-30',
      tasks: [
        { title: '確定申告の書類を集める', time: '終日', type: '前進', project: '生活', memo: '去年の控えを見る' },
        { title: '床屋', time: '15:00-16:00', type: 'ルーチン', project: '生活' }
      ]
    }));
    assert.equal(r.changed, true);
    assert.deepEqual(r.added, ['確定申告の書類を集める', '床屋']);
  });
  assert.equal(f.commits.length, 1, '2件でもコミットは1本');
  const d = f.days().get('2026-08-30');
  assert.equal(d.length, 2);
  assert.equal(d[0].memo, '去年の控えを見る');
  assert.equal(d[0].proj, '生活');
  assert.equal(f.titles().length, 11);
});

test('add_tasks: replace でその日だけ丸ごと入れ替わる（朝の入れ替え）', async () => {
  const f = fixture();
  await withClient(f.io, async client => {
    await call(client, 'add_tasks', {
      date: '2026-08-29', replace: true, tasks: [{ title: '休み', time: '終日' }]
    });
  });
  const days = f.days();
  assert.deepEqual(days.get('2026-08-29').map(t => t.title), ['休み']);
  assert.equal(days.get('2026-08-27').length, 3, '他の日は無傷');
  assert.equal(days.get('2026-08-28').length, 3);
  assert.equal(f.commits.length, 1);
});

test('update_task: 渡した欄だけ変わる', async () => {
  const f = fixture();
  await withClient(f.io, async client => {
    const r = payload(await call(client, 'update_task', { id: '2026-08-28#1', title: '現場（渋谷）' }));
    assert.equal(r.changed, true);
  });
  const t = f.days().get('2026-08-28')[0];
  assert.equal(t.title, '現場（渋谷）');
  assert.equal(t.time, '07:00-19:00');
  assert.equal(t.proj, '仕事');
  assert.equal(t.memo, '現場が決まったらカレンダーのタイトルに追記');
  assert.equal(f.text.split('\n').length, ORIG.split('\n').length);
});

test('move_tasks: 繰り越しでチェックもメモも持っていく', async () => {
  const f = fixture();
  await withClient(f.io, async client => {
    const r = payload(await call(client, 'move_tasks', {
      ids: ['2026-08-28#2', '2026-08-28#3'], date: '2026-08-29'
    }));
    assert.equal(r.to, '2026-08-29');
    assert.equal(r.moved.length, 2);
  });
  assert.equal(f.commits.length, 1);
  const days = f.days();
  assert.equal(days.get('2026-08-28').length, 1);
  assert.equal(days.get('2026-08-29').length, 5);
  const moved = days.get('2026-08-29').at(-2);
  assert.equal(moved.title, 'Project カスタム指示を貼り替える');
  assert.equal(moved.memo, 'これをやらないと 8/26 に決めた変更が効かない');
  assert.equal(f.titles().length, 9, '総数は変わらない');
});

test('remove_tasks: メモ行ごと消える', async () => {
  const f = fixture();
  await withClient(f.io, async client => {
    const r = payload(await call(client, 'remove_tasks', { ids: ['2026-08-27#1', '2026-08-29#2'] }));
    assert.equal(r.removed.length, 2);
  });
  assert.equal(f.titles().length, 7);
  assert.ok(!f.text.includes('配達証明の控えを保管する'));
  assert.equal(f.commits.length, 1);
});

test('一連の操作を通しても、足して消せば完全に元へ戻る', async () => {
  const f = fixture();
  await withClient(f.io, async client => {
    await call(client, 'add_tasks', { date: '2026-08-29', tasks: [{ title: '新規', memo: 'め' }] });
    await call(client, 'set_done', { ids: ['2026-08-29#4'], done: true });
    await call(client, 'update_task', { id: '2026-08-29#4', type: '前進', project: '雑' });
    await call(client, 'move_tasks', { ids: ['2026-08-29#4'], date: '2026-08-27' });
    await call(client, 'remove_tasks', { ids: ['2026-08-27#4'] });
  });
  assert.equal(f.text, ORIG);
  assert.equal(f.commits.length, 5);
});

test('壊れた入力はエラーとして返り、コミットしない', async () => {
  const f = fixture();
  await withClient(f.io, async client => {
    for (const [name, args, pattern] of [
      ['set_done', { ids: ['2030-01-01#1'], done: true }, /その日付はありません/],
      ['set_done', { ids: ['2026-08-28#1'], done: 'yes' }, /./],
      ['add_tasks', { date: '8/29', tasks: [{ title: 'a' }] }, /日付の形式/],
      ['add_tasks', { date: '2026-08-29', tasks: [{ title: '  ' }] }, /タスク名が空/],
      ['update_task', { id: 'nope', title: 'a' }, /id の形式/],
      ['move_tasks', { ids: ['2026-08-27#1'], date: '2026-08-27' }, /既に 2026-08-27/],
      ['remove_tasks', { ids: ['2026-08-27#99'] }, /99 番目のタスクはありません/]
    ]) {
      const res = await call(client, name, args);
      assert.equal(res.isError, true, `${name} ${JSON.stringify(args)}`);
      assert.match(res.content[0].text, pattern, name);
    }
  });
  assert.equal(f.commits.length, 0);
  assert.equal(f.text, ORIG);
});

test('GitHub 側が落ちてもエラーとして返る', async () => {
  const io = () => ({
    readTasks: async () => { throw new Error('GITHUB_TOKEN が無効か期限切れです'); },
    writeTasks: async () => { throw new Error('unreachable'); }
  });
  await withClient(io, async client => {
    for (const [name, args] of [['get_tasks', {}], ['remove_tasks', { ids: ['2026-08-27#1'] }]]) {
      const res = await call(client, name, args);
      assert.equal(res.isError, true);
      assert.match(res.content[0].text, /GITHUB_TOKEN/);
    }
  });
});

test('書き込みが競合したらエラーとして返る', async () => {
  // 読んだ後に外で更新された状況（読みは古い sha を返す）
  const io = () => ({
    async readTasks() { return { text: ORIG, sha: 'stale' }; },
    async writeTasks(_t, sha) {
      if (sha !== 'current') throw new Error('別の場所で先に更新されていました。読み直してからやり直してください');
      return 'next';
    }
  });
  await withClient(io, async client => {
    const res = await call(client, 'set_done', { ids: ['2026-08-28#1'], done: true });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /先に更新されていました/);
  });
});

test('ホストがパラメータを渡さず本文も生のままでも動く', async () => {
  const f = fixture();
  await withClient(f.io, async client => {
    const out = payload(await call(client, 'get_tasks', { scope: 'all' }));
    assert.equal(out.days.flatMap(d => d.tasks).length, 9);
  }, { opts: { passKey: false, parseBody: false } });
});

test('URL から拾った合鍵も違えば弾く', async () => {
  await expectNoConnect(fixture().io, 'nope');
});
