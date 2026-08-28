import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse, writeDone, writeMemo, findTask, snapshot, todayKey, windowKeys } from '../lib/tasks.js';

const ORIG = readFileSync(new URL('../../tasks.txt', import.meta.url), 'utf8');

test('parse: 日付ごとにタスクを拾い、メモを畳む', () => {
  const { days } = parse(ORIG);
  assert.deepEqual([...days.keys()], ['2026-08-27', '2026-08-28', '2026-08-29']);
  assert.equal([...days.values()].flat().length, 9);

  const t = days.get('2026-08-27')[0];
  assert.equal(t.id, '2026-08-27#1');
  assert.equal(t.done, true);
  assert.equal(t.time, '10:00-11:00');
  assert.equal(t.type, '前進');
  assert.equal(t.kind, 'accel');
  assert.equal(t.proj, '訴訟');
  assert.equal(t.title, '郵便局で附票・除票の第三者請求を発送');
  assert.equal(t.memo, '配達証明の控えを保管する');
});

test('parse: コメント行と空行は無視される', () => {
  const { days } = parse(ORIG);
  const titles = [...days.values()].flat().map(t => t.title);
  assert.equal(titles.some(x => x.startsWith('//')), false);
});

test('writeDone: 該当行だけが変わり、付けて外すと完全に元へ戻る', () => {
  const { lines, days } = parse(ORIG);
  const task = findTask(days, '2026-08-28#2');
  assert.equal(task.title, 'Project カスタム指示を貼り替える');

  writeDone(lines, task.at, true);
  const after = lines.join('\n');
  assert.match(after, /^- \[x\] 終日 \| 前進 \| Vault \| Project カスタム指示を貼り替える$/m);
  assert.equal(after.split('\n').length, ORIG.split('\n').length);
  // 変わった行はちょうど1本
  const diff = after.split('\n').filter((l, i) => l !== ORIG.split('\n')[i]);
  assert.equal(diff.length, 1);

  writeDone(lines, task.at, false);
  assert.equal(lines.join('\n'), ORIG);
});

test('writeMemo: 追加・複数行・差し替え・削除', () => {
  // 追加（メモなしのタスク）
  {
    const { lines, days } = parse(ORIG);
    const t = findTask(days, '2026-08-27#2');
    assert.equal(t.memo, '');
    writeMemo(lines, t, '延滞を確認\n次は9月');
    const out = lines.join('\n');
    assert.ok(out.includes('  memo: 延滞を確認\n  memo: 次は9月'));
    assert.equal(out.split('\n').length, ORIG.split('\n').length + 2);
    // 往復できる
    assert.equal(findTask(parse(out).days, '2026-08-27#2').memo, '延滞を確認\n次は9月');
  }
  // 差し替え
  {
    const { lines, days } = parse(ORIG);
    writeMemo(lines, findTask(days, '2026-08-27#1'), '控えは封筒ごと保管');
    const out = lines.join('\n');
    assert.ok(out.includes('memo: 控えは封筒ごと保管'));
    assert.ok(!out.includes('配達証明の控えを保管する'));
    assert.equal(out.split('\n').length, ORIG.split('\n').length);
  }
  // 削除
  {
    const { lines, days } = parse(ORIG);
    writeMemo(lines, findTask(days, '2026-08-27#1'), '');
    const out = lines.join('\n');
    assert.ok(!out.includes('配達証明の控えを保管する'));
    assert.equal(out.split('\n').length, ORIG.split('\n').length - 1);
    // タスク行は無傷
    assert.match(out, /^- \[x\] 10:00-11:00 \| 前進 \| 訴訟 \| 郵便局で附票・除票の第三者請求を発送$/m);
  }
});

test('findTask: 壊れた id は理由付きで弾く', () => {
  const { days } = parse(ORIG);
  assert.throws(() => findTask(days, 'nope'), /id の形式/);
  assert.throws(() => findTask(days, '2026-01-01#1'), /その日付はありません/);
  assert.throws(() => findTask(days, '2026-08-27#99'), /99 番目のタスクはありません/);
});

test('todayKey: UTC ではなく Asia/Tokyo で日付が出る', () => {
  // 2026-08-28 16:00 UTC は東京では 8/29 の 01:00
  const t = new Date('2026-08-28T16:00:00Z');
  assert.equal(todayKey('Asia/Tokyo', t), '2026-08-29');
  assert.equal(todayKey('UTC', t), '2026-08-28');

  // 東京の 00:30（前日 15:30 UTC）
  const u = new Date('2026-08-27T15:30:00Z');
  assert.equal(todayKey('Asia/Tokyo', u), '2026-08-28');
});

test('windowKeys: 月をまたいでも昨日・今日・明日が連続する', () => {
  const w = windowKeys('Asia/Tokyo', new Date('2026-08-31T03:00:00Z'));
  assert.deepEqual(w.map(x => x.date), ['2026-08-30', '2026-08-31', '2026-09-01']);
  assert.deepEqual(w.map(x => x.rel), ['昨日', '今日', '明日']);

  const y = windowKeys('Asia/Tokyo', new Date('2026-12-31T15:30:00Z')); // 東京では 2027-01-01
  assert.deepEqual(y.map(x => x.date), ['2026-12-31', '2027-01-01', '2027-01-02']);
});

test('snapshot: window は3日固定、タスクのない日も枠が残る', () => {
  const { days } = parse(ORIG);
  const s = snapshot(days, 'window', 'Asia/Tokyo', new Date('2026-08-28T03:00:00Z'));
  assert.equal(s.today, '2026-08-28');
  assert.equal(s.days.length, 3);
  assert.deepEqual(s.days.map(d => d.rel), ['昨日', '今日', '明日']);
  assert.equal(s.days[1].tasks.length, 3);
  assert.equal(s.days[1].tasks[1].id, '2026-08-28#2');

  const empty = snapshot(days, 'window', 'Asia/Tokyo', new Date('2027-05-05T03:00:00Z'));
  assert.deepEqual(empty.days.map(d => d.tasks.length), [0, 0, 0]);
});

test('snapshot: all はファイル内の全日付を日付順で返す', () => {
  const { days } = parse(ORIG);
  const s = snapshot(days, 'all', 'Asia/Tokyo', new Date('2027-05-05T03:00:00Z'));
  assert.deepEqual(s.days.map(d => d.date), ['2026-08-27', '2026-08-28', '2026-08-29']);
});
