import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parse, findTask, formatTask, snapshot, setDone, setMemo, updateTask, addTasks, removeTasks, moveTasks,
  pruneEmptyDays
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

/* ---------- 「いつでも」（日付に紐づかない置き場） ---------- */

const WITH_ANY = ORIG + '\n# いつでも\n- [ ] 郵便を出す\n  memo: ついでにコンビニ\n- [x] 電池を買う\n';

test('いつでも: 見出しを認識し、日付とは別に持つ', () => {
  const { days } = parse(WITH_ANY);
  assert.deepEqual([...days.keys()], ['2026-08-27', '2026-08-28', '2026-08-29', 'anytime']);
  const list = days.get('anytime');
  assert.deepEqual(list.map(t => t.id), ['anytime#1', 'anytime#2']);
  assert.equal(list[0].memo, 'ついでにコンビニ');
  assert.equal(list[1].done, true);
});

test('いつでも: 表記ゆれも拾う', () => {
  for (const head of ['# いつでも', '#いつでも', '# anytime', '# INBOX']) {
    const { days } = parse(`${head}\n- [ ] あ\n`);
    assert.equal(days.get('anytime')?.length, 1, head);
  }
});

test('いつでも: 日付として扱わない', () => {
  const { days } = parse(WITH_ANY);
  const s = snapshot(days, 'window', 'Asia/Tokyo', new Date('2026-08-28T03:00:00+09:00'));
  assert.equal(s.days.length, 3, '窓はあくまで3日');
  assert.equal(s.days.some(d => d.date === 'anytime'), false);
  assert.equal(s.anytime.length, 2, 'いつでもは別枠で必ず返る');

  const all = snapshot(days, 'all', 'Asia/Tokyo', new Date('2027-01-01T00:00:00+09:00'));
  assert.deepEqual(all.days.map(d => d.date), ['2026-08-27', '2026-08-28', '2026-08-29']);
  assert.equal(all.anytime.length, 2, 'scope=all でも別枠');
});

test('いつでも: 無ければ空で返る', () => {
  const s = snapshot(parse(ORIG).days, 'window', 'Asia/Tokyo', new Date('2026-08-28T03:00:00+09:00'));
  assert.deepEqual(s.anytime, []);
});

test('いつでも: 見出しごと作られ、末尾に付く', () => {
  const r = addTasks(ORIG, 'anytime', [{ title: '郵便を出す', memo: 'ついで' }]);
  assert.ok(r.text.includes('# いつでも'));
  assert.ok(r.text.indexOf('# いつでも') > r.text.indexOf('# 2026-08-29'), '日付の後ろ');
  assert.deepEqual(parse(r.text).days.get('anytime').map(t => t.title), ['郵便を出す']);
  assert.equal(parse(r.text).days.get('anytime')[0].memo, 'ついで');
});

test('いつでも: 既にあれば末尾に足す', () => {
  const r = addTasks(WITH_ANY, 'anytime', [{ title: '爪を切る' }]);
  assert.deepEqual(parse(r.text).days.get('anytime').map(t => t.title),
    ['郵便を出す', '電池を買う', '爪を切る']);
  assert.equal((r.text.match(/# いつでも/g) || []).length, 1, '見出しは増えない');
});

test('いつでも: 新しい日付は「いつでも」より前に入る', () => {
  const r = addTasks(WITH_ANY, '2026-09-05', [{ title: '来週' }]);
  assert.ok(r.text.indexOf('# 2026-09-05') < r.text.indexOf('# いつでも'));
  assert.equal(parse(r.text).days.get('anytime').length, 2, 'いつでもは無傷');
});

test('いつでも: チェック・メモ・削除が効く', () => {
  let text = setDone(WITH_ANY, ['anytime#1'], true).text;
  assert.match(text, /^- \[x\] 郵便を出す$/m);

  text = setMemo(text, ['anytime#1'][0], '窓口は17時まで').text;
  assert.ok(text.includes('memo: 窓口は17時まで'));
  assert.ok(!text.includes('ついでにコンビニ'));

  text = removeTasks(text, ['anytime#2']).text;
  assert.deepEqual(parse(text).days.get('anytime').map(t => t.title), ['郵便を出す']);
});

test('いつでも: 日付との間を行き来できる', () => {
  const toDay = moveTasks(WITH_ANY, ['anytime#1'], '2026-08-28');
  let days = parse(toDay.text).days;
  assert.equal(days.get('anytime').length, 1);
  assert.equal(days.get('2026-08-28').length, 4);
  assert.equal(days.get('2026-08-28').at(-1).memo, 'ついでにコンビニ', 'メモを持っていく');

  const toAny = moveTasks(WITH_ANY, ['2026-08-29#1'], 'anytime');
  days = parse(toAny.text).days;
  assert.equal(days.get('2026-08-29').length, 2);
  assert.deepEqual(days.get('anytime').map(t => t.title),
    ['郵便を出す', '電池を買う', 'ヒューリック恵比寿解体']);
});

test('いつでも: 足して消せば元通り', () => {
  const added = addTasks(ORIG, 'anytime', [{ title: '一時的' }]).text;
  const back = removeTasks(added, ['anytime#1']).text;
  // 見出しと空行は残る。タスクは消えている
  assert.equal(parse(back).days.get('anytime').length, 0);
  assert.ok(back.startsWith('// 書き方は README.md を参照'));
  assert.deepEqual(titles(back), titles(ORIG));
});

test('いつでも: 壊れた id は弾く', () => {
  const { days } = parse(ORIG);
  assert.throws(() => findTask(days, 'anytime#1'), /その日付はありません/);
  assert.throws(() => findTask(days, 'anytime'), /id の形式/);
});

/* ---------- 空になった過去の日付を片付ける ---------- */

// 2026-09-05 を「今日」に固定する。窓は 9/4・9/5・9/6。
const NOW = new Date('2026-09-05T10:00:00+09:00');
const prune = text => pruneEmptyDays(text, 'Asia/Tokyo', NOW);
const heads = text => [...parse(text).headers.keys()];

test('prune: 中身の無い過去の見出しは節ごと消える', () => {
  const src = '# 2026-08-27\n\n# 2026-08-28\n\n# 2026-09-05\n- [ ] 今日の分\n';
  const { text, pruned } = prune(src);
  assert.deepEqual(pruned, ['2026-08-27', '2026-08-28']);
  assert.equal(text, '# 2026-09-05\n- [ ] 今日の分\n');
});

test('prune: 中身のある過去の日は残る', () => {
  const src = '# 2026-08-27\n- [x] 済んだやつ\n\n# 2026-08-28\n\n';
  const { text, pruned } = prune(src);
  assert.deepEqual(pruned, ['2026-08-28']);
  assert.ok(text.includes('# 2026-08-27'));
  assert.ok(text.includes('済んだやつ'));
});

test('prune: 3日の窓の中は空でも残す（枠として要る）', () => {
  const src = '# 2026-09-04\n\n# 2026-09-05\n\n# 2026-09-06\n\n';
  assert.deepEqual(prune(src).pruned, []);
  assert.equal(prune(src).text, src);
});

test('prune: 未来の空の日付は残す（これから入れる場所）', () => {
  const src = '# 2026-09-20\n\n# 2026-10-01\n\n';
  assert.deepEqual(prune(src).pruned, []);
});

test('prune: 「いつでも」は空でも消さない', () => {
  const src = '# いつでも\n\n# 2026-08-01\n\n';
  const { text, pruned } = prune(src);
  assert.deepEqual(pruned, ['2026-08-01']);
  assert.ok(text.includes('# いつでも'));
});

test('prune: 空行以外が残っている節は巻き込まない', () => {
  const src = '# 2026-08-27\n// あとで書く\n\n# 2026-08-28\n\n';
  const { text, pruned } = prune(src);
  assert.deepEqual(pruned, ['2026-08-28']);
  assert.ok(text.includes('# 2026-08-27'));
  assert.ok(text.includes('// あとで書く'));
});

test('prune: 先頭のコメント帯と、消えない日の中身は無傷', () => {
  const { text, pruned } = prune(ORIG);
  assert.deepEqual(pruned, []);                       // fixture に空の日は無い
  assert.equal(text, ORIG);
});

test('prune: 消したあとに空行が溜まらない', () => {
  const src = '// 見出しより上は触らない\n\n# 2026-08-27\n\n\n\n# 2026-08-28\n\n\n';
  const { text } = prune(src);
  assert.equal(text, '// 見出しより上は触らない\n');
  assert.ok(!/\n\n\n/.test(text));

  // 全部消えて何も残らなければ空になる
  assert.equal(prune('# 2026-08-27\n\n\n').text, '');
});

test('prune: 最後のタスクを消した過去の日は、見出しごと消える', () => {
  const src = '# 2026-08-27\n- [ ] 消す予定\n\n# 2026-09-05\n- [ ] 今日の分\n';
  const id = parse(src).days.get('2026-08-27')[0].id;
  const cut = removeTasks(src, [id]).text;
  assert.ok(heads(cut).includes('2026-08-27'), '消した直後は見出しが残っている');
  const { text, pruned } = prune(cut);
  assert.deepEqual(pruned, ['2026-08-27']);
  assert.deepEqual(heads(text), ['2026-09-05']);
  assert.ok(text.includes('今日の分'));
});

test('prune: 何度かけても結果は同じ', () => {
  const src = '# 2026-08-27\n\n# 2026-09-05\n- [ ] 今日の分\n';
  const once = prune(src).text;
  assert.equal(prune(once).text, once);
  assert.deepEqual(prune(once).pruned, []);
});
