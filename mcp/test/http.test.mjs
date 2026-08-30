// ビューアが叩く /api/tasks を、実物の HTTP と fetch で確かめる。
// GitHub だけ差し替える。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createTasksApi } from '../lib/tasks-api.js';

const ORIG = readFileSync(new URL('./fixture.txt', import.meta.url), 'utf8');
const PIN = '0402';

function fixture() {
  const state = { store: { text: ORIG, sha: 'sha0' }, commits: [] };
  state.io = {
    async readTasks() { return { ...state.store }; },
    async writeTasks(text, sha, message) {
      if (sha !== state.store.sha) throw new Error('別の場所で先に更新されていました。読み直してからやり直してください');
      state.store = { text, sha: 'sha' + (state.commits.length + 1) };
      state.commits.push({ message, text });
      return state.store.sha;
    }
  };
  return state;
}

/** サーバーを立てて fn を走らせ、必ず閉じる。失敗の待ち時間は 0 にしておく。 */
async function withApi(io, fn) {
  const handler = createTasksApi(io, { sleep: async () => {} });
  const srv = createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => { if (raw) req.body = raw; handler(req, res); });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}/api/tasks`;
  try { return await fn(base); }
  finally { srv.closeAllConnections?.(); srv.close(); }
}

const get = (base, pin) => fetch(base, { headers: pin ? { 'X-Pin': pin } : {} });
const put = (base, pin, body) => fetch(base, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', ...(pin ? { 'X-Pin': pin } : {}) },
  body: JSON.stringify(body)
});

test('暗証番号が合えば読める', async () => {
  process.env.EDIT_PIN = PIN;
  const f = fixture();
  await withApi(f.io, async base => {
    const r = await get(base, PIN);
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.text, ORIG);
    assert.equal(j.sha, 'sha0');
  });
  assert.equal(f.commits.length, 0);
});

test('暗証番号が違えば 401、GitHub には触らない', async () => {
  process.env.EDIT_PIN = PIN;
  const f = fixture();
  let touched = false;
  f.io.readTasks = async () => { touched = true; return { text: ORIG, sha: 'x' }; };
  await withApi(f.io, async base => {
    for (const bad of ['0000', '', '04020', '040']) {
      const r = await get(base, bad);
      assert.equal(r.status, 401, `pin=${bad}`);
      assert.match((await r.json()).error, /暗証番号/);
    }
    assert.equal((await get(base, null)).status, 401, '未指定も 401');
  });
  assert.equal(touched, false, '認証前に GitHub を読まない');
});

test('EDIT_PIN 未設定なら誰も通さない', async () => {
  delete process.env.EDIT_PIN;
  await withApi(fixture().io, async base => {
    const r = await get(base, PIN);
    assert.equal(r.status, 503);
    assert.match((await r.json()).error, /EDIT_PIN/);
  });
  process.env.EDIT_PIN = PIN;
});

test('クエリでも暗証番号を渡せる', async () => {
  process.env.EDIT_PIN = PIN;
  await withApi(fixture().io, async base => {
    assert.equal((await fetch(`${base}?pin=${PIN}`)).status, 200);
    assert.equal((await fetch(`${base}?pin=9999`)).status, 401);
  });
});

test('書き込めて、sha が返る', async () => {
  process.env.EDIT_PIN = PIN;
  const f = fixture();
  await withApi(f.io, async base => {
    const next = ORIG.replace('- [ ] 終日 | 前進 | Vault', '- [x] 終日 | 前進 | Vault');
    const r = await put(base, PIN, { text: next, sha: 'sha0', message: 'tasks: 完了' });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).sha, 'sha1');
  });
  assert.equal(f.commits.length, 1);
  assert.equal(f.commits[0].message, 'tasks: 完了');
  assert.match(f.store.text, /^- \[x\] 終日 \| 前進 \| Vault/m);
});

test('sha が古ければ 409', async () => {
  process.env.EDIT_PIN = PIN;
  const f = fixture();
  await withApi(f.io, async base => {
    const r = await put(base, PIN, { text: ORIG + '\n', sha: 'ふるい', message: 'x' });
    assert.equal(r.status, 409);
    assert.match((await r.json()).error, /先に更新されていました/);
  });
  assert.equal(f.commits.length, 0);
});

test('壊れた本文は弾く', async () => {
  process.env.EDIT_PIN = PIN;
  const f = fixture();
  await withApi(f.io, async base => {
    assert.equal((await put(base, PIN, { sha: 'sha0' })).status, 400, 'text なし');
    assert.equal((await put(base, PIN, { text: 'a' })).status, 400, 'sha なし');
    assert.equal((await put(base, PIN, { text: 'x'.repeat(200_001), sha: 'sha0' })).status, 413, '大きすぎ');
  });
  assert.equal(f.commits.length, 0);
});

test('GitHub が落ちていればそのまま伝える', async () => {
  process.env.EDIT_PIN = PIN;
  await withApi({
    readTasks: async () => { throw new Error('GITHUB_TOKEN が無効か期限切れです'); },
    writeTasks: async () => { throw new Error('GITHUB_TOKEN が無効か期限切れです'); }
  }, async base => {
    const r = await get(base, PIN);
    assert.equal(r.status, 500);
    assert.match((await r.json()).error, /GITHUB_TOKEN/);
  });
});

test('CORS: ビューアのオリジンだけ許し、プリフライトに答える', async () => {
  process.env.EDIT_PIN = PIN;
  await withApi(fixture().io, async base => {
    const pre = await fetch(base, { method: 'OPTIONS' });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), 'https://reiji55.github.io');
    assert.match(pre.headers.get('access-control-allow-methods'), /PUT/);
    assert.match(pre.headers.get('access-control-allow-headers'), /X-Pin/i);

    const r = await get(base, PIN);
    assert.equal(r.headers.get('access-control-allow-origin'), 'https://reiji55.github.io');
    assert.equal(r.headers.get('cache-control'), 'no-store');
  });
});

test('GET と PUT 以外は 405', async () => {
  process.env.EDIT_PIN = PIN;
  await withApi(fixture().io, async base => {
    for (const method of ['POST', 'DELETE', 'PATCH']) {
      assert.equal((await fetch(base, { method, headers: { 'X-Pin': PIN } })).status, 405, method);
    }
  });
});
