import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parse, findTask, formatTask, setDone, setMemo, updateTask, addTasks, removeTasks, moveTasks
} from '../lib/tasks.js';

const ORIG = readFileSync(new URL('./fixture.txt', import.meta.url), 'utf8');
const titles = text => [...parse(text).days.values()].flat().map(t => t.title);
const count = text => titles(text).length;

test('formatTask: 空欄は - で埋め、末尾の空欄は落とす', () => {
  assert.equal(formatTask({ title: 'あ' }), '- [ ] あ');
  assert.equal(formatTask({ title: 'あ', done: true }), '- [x] あ');
  assert.equal(formatTask({ title: 'あ', time: '終日' }), '- [ ] 終日 | あ');
  assert.equal(formatTask({ title: 'あ', time: '終日', type: '前進' }), '- [ ] 終日 | 前進 | あ');
  assert.equal(formatTask({ title: 'あ', type: '前進' }), '- [ ] - | 前進 | あ');
  assert.equal(formatTask({ title: 'あ', proj: '訴訟' }), '- [ ] - | - | 訴訟 | あ');
  assert.equal(formatTask({ title: 'あ', time: '終日', proj: '訴訟' }), '- [ ] 終日 | - | 訴訟 | あ');
});

test('formatTask: 組み立てた行は parse で元に戻る', () => {
  for (const t of [
    { title: 'あ' },
    { title: 'あ', time: '10:00-11:00' },
    { title: 'あ', type: '前進' },
    { title: 'あ', proj: '訴訟' },
    { title: 'あ', time: '終日', type: 'ルーチン', proj: '仕事', done: true },
    { title: 'A | B を比べる' }                       // タスク名に | が入る場合
  ]) {
    const text = `# 2026-08-28\n${formatTask(t)}\n`;
    const got = parse(text).days.get('2026-08-28')[0];
    assert.equal(got.title, t.title, JSON.stringify(t));
    assert.equal(got.time, t.time || '');
    assert.equal(got.type, t.type || '');
    assert.equal(got.proj, t.proj || '');
    assert.equal(got.done, !!t.done);
  }
});

test('formatTask: 壊れた入力は弾く', () => {
  assert.throws(() => formatTask({ title: '' }), /タスク名が空/);
  assert.throws(() => formatTask({ title: 'あ\nい' }), /改行/);
  assert.throws(() => formatTask({ title: 'あ', time: 'a|b' }), /改行や \| /);
});

test('setDone: まとめて付けられ、既に同じものは数えない', () => {
  const r = setDone(ORIG, ['2026-08-28#1', '2026-08-28#3', '2026-08-27#1'], true);
  assert.equal(r.updated.length, 2);        // 27#1 は元から [x]
  assert.equal(r.skipped, 1);
  assert.equal((r.text.match(/\[x\]/g) || []).length, 4);
  assert.equal(r.text.split('\n').length, ORIG.split('\n').length);

  // 付けて外すと完全に元へ戻る
  const back = setDone(r.text, ['2026-08-28#1', '2026-08-28#3'], false);
  assert.equal(back.text, ORIG);
});

test('addTasks: 既存の日の末尾／先頭に入る', () => {
  const end = addTasks(ORIG, '2026-08-28', [{ title: '銀行に行く', time: '12:00-13:00', type: 'ルーチン', project: '生活' }]);
  const d = parse(end.text).days.get('2026-08-28');
  assert.equal(d.length, 4);
  assert.equal(d[3].title, '銀行に行く');
  assert.equal(d[3].proj, '生活');
  assert.equal(count(end.text), 10);

  const start = addTasks(ORIG, '2026-08-28', [{ title: '銀行に行く' }], { position: 'start' });
  assert.equal(parse(start.text).days.get('2026-08-28')[0].title, '銀行に行く');
});

test('addTasks: メモ付きで入り、複数まとめても入る', () => {
  const r = addTasks(ORIG, '2026-08-28', [
    { title: 'A', memo: '1行目\n2行目' },
    { title: 'B', type: '前進' }
  ]);
  const d = parse(r.text).days.get('2026-08-28');
  assert.equal(d.at(-2).memo, '1行目\n2行目');
  assert.equal(d.at(-1).title, 'B');
  assert.equal(count(r.text), 11);
});

test('addTasks: 新しい日付は見出しごと、日付順の位置に入る', () => {
  const mid = addTasks(ORIG, '2026-08-28-x'.slice(0, 10), [{ title: 'z' }]); // 既存日と同じなので末尾扱い
  assert.ok(mid.text.includes('# 2026-08-28'));

  const before = addTasks(ORIG, '2026-08-26', [{ title: '前の日' }]);
  assert.deepEqual([...parse(before.text).days.keys()], ['2026-08-26', '2026-08-27', '2026-08-28', '2026-08-29']);
  assert.ok(before.text.indexOf('# 2026-08-26') < before.text.indexOf('# 2026-08-27'));

  const after = addTasks(ORIG, '2026-08-30', [{ title: '次の日' }]);
  assert.deepEqual([...parse(after.text).days.keys()], ['2026-08-27', '2026-08-28', '2026-08-29', '2026-08-30']);
  assert.ok(after.text.indexOf('# 2026-08-30') > after.text.indexOf('# 2026-08-29'));
  assert.ok(after.text.endsWith('\n'), '末尾の改行が残る');

  const between = addTasks(ORIG, '2026-08-28'.replace('28', '28'), [{ title: 'x' }]);
  assert.equal(parse(between.text).days.size, 3);
});

test('addTasks: replace はその日だけを丸ごと入れ替える', () => {
  const r = addTasks(ORIG, '2026-08-29', [
    { title: '現場', time: '07:00-19:00', type: 'ルーチン', project: '仕事' },
    { title: '稽古', time: '19:00-22:00', type: 'ルーチン', project: 'KAPAP' }
  ], { replace: true });

  const days = parse(r.text).days;
  assert.equal(days.get('2026-08-29').length, 2);
  assert.deepEqual(days.get('2026-08-29').map(t => t.title), ['現場', '稽古']);
  // 他の日は無傷
  assert.equal(days.get('2026-08-27').length, 3);
  assert.equal(days.get('2026-08-28').length, 3);
  assert.ok(r.text.startsWith('// 書き方は README.md を参照'));
});

test('addTasks: 壊れた入力は弾く', () => {
  assert.throws(() => addTasks(ORIG, '8/29', [{ title: 'a' }]), /日付の形式/);
  assert.throws(() => addTasks(ORIG, '2026-08-29', []), /追加するタスクがありません/);
  assert.throws(() => addTasks(ORIG, '2026-08-29', [{ title: '  ' }]), /タスク名が空/);
});

test('removeTasks: メモ行も一緒に消え、複数指定でも取り違えない', () => {
  const one = removeTasks(ORIG, ['2026-08-27#1']);
  assert.equal(count(one.text), 8);
  assert.ok(!one.text.includes('配達証明の控えを保管する'), 'メモ行も消える');
  assert.equal(one.text.split('\n').length, ORIG.split('\n').length - 2);

  // 同じ日の複数件（消すと後ろの番号がずれる組み合わせ）
  const many = removeTasks(ORIG, ['2026-08-27#1', '2026-08-27#3']);
  const left = parse(many.text).days.get('2026-08-27');
  assert.equal(left.length, 1);
  assert.equal(left[0].title, '図書館に本を返す');

  // 日をまたいで
  const across = removeTasks(ORIG, ['2026-08-27#2', '2026-08-29#1']);
  assert.equal(count(across.text), 7);
  assert.ok(!titles(across.text).includes('図書館に本を返す'));
  assert.ok(!titles(across.text).includes('ヒューリック恵比寿解体'));
});

test('moveTasks: チェックもメモも持っていく', () => {
  const r = moveTasks(ORIG, ['2026-08-27#1', '2026-08-27#3'], '2026-08-29');
  const days = parse(r.text).days;
  assert.equal(days.get('2026-08-27').length, 1);
  assert.equal(days.get('2026-08-29').length, 5);

  const moved = days.get('2026-08-29').slice(-2);
  assert.equal(moved[0].title, '郵便局で附票・除票の第三者請求を発送');
  assert.equal(moved[0].done, true, 'チェックがそのまま');
  assert.equal(moved[0].memo, '配達証明の控えを保管する', 'メモがそのまま');
  assert.equal(moved[0].proj, '訴訟');
  assert.equal(moved[1].title, '未経験可・年収400万以上の職種リストを作る');
  assert.equal(count(r.text), 9, '総数は変わらない');
});

test('moveTasks: 存在しない日付へも見出しごと移せる', () => {
  const r = moveTasks(ORIG, ['2026-08-28#3'], '2026-08-30');
  assert.deepEqual(parse(r.text).days.get('2026-08-30').map(t => t.title),
    ['現在のステータスを整理して、次のタスクを切り出す']);
  assert.equal(count(r.text), 9);
});

test('moveTasks: 同じ日付には移せない', () => {
  assert.throws(() => moveTasks(ORIG, ['2026-08-27#1'], '2026-08-27'), /既に 2026-08-27 にあります|既に 2026-08-27 に/);
});

test('updateTask: 渡した欄だけ変わる', () => {
  const r = updateTask(ORIG, '2026-08-28#1', { title: '現場（渋谷）' });
  const t = findTask(parse(r.text).days, '2026-08-28#1');
  assert.equal(t.title, '現場（渋谷）');
  assert.equal(t.time, '07:00-19:00', '時間帯はそのまま');
  assert.equal(t.type, 'ルーチン');
  assert.equal(t.proj, '仕事');
  assert.equal(t.memo, '現場が決まったらカレンダーのタイトルに追記', 'メモはそのまま');
  assert.equal(r.text.split('\n').length, ORIG.split('\n').length);
});

test('updateTask: 空文字で欄を消せる', () => {
  const r = updateTask(ORIG, '2026-08-28#1', { project: '', time: '' });
  const t = findTask(parse(r.text).days, '2026-08-28#1');
  assert.equal(t.proj, '');
  assert.equal(t.time, '');
  assert.equal(t.type, 'ルーチン');
  assert.equal(t.title, '現場（未定）');
});

test('setMemo: 同じ内容なら何もしない', () => {
  const r = setMemo(ORIG, '2026-08-27#1', '配達証明の控えを保管する');
  assert.equal(r.text, ORIG);
});

test('どの操作でもコメント行と全体の書式は残る', () => {
  let text = ORIG;
  text = addTasks(text, '2026-08-30', [{ title: '新規', memo: 'め' }]).text;
  text = setDone(text, ['2026-08-30#1'], true).text;
  text = updateTask(text, '2026-08-30#1', { type: '前進' }).text;
  text = moveTasks(text, ['2026-08-30#1'], '2026-08-28').text;
  text = removeTasks(text, ['2026-08-28#4']).text;

  assert.ok(text.startsWith('// 書き方は README.md を参照\n// - [ ] 時間帯'));
  assert.equal(count(text), 9);
  assert.deepEqual(titles(text), titles(ORIG));
});
