import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBoard, buildBoard, setCard, removeCard, summary } from '../lib/board.js';

const NOW = new Date('2026-09-09T14:20:00+09:00');
const opt = { now: NOW };

const BOARD = JSON.stringify({
  updated: '2026-09-01T09:00:00+09:00',
  cards: [
    { id: 'toeic', title: 'TOEIC対策', created: '2026-08-20',
      goal: '11月の試験で700点', detail: 'ルーチン型で週1枠。' },
    { id: 'trade', title: 'AIトレード', created: '2026-09-01', purpose: '収入の柱を増やす' }
  ]
}, null, 2);

test('parseBoard: 空でもカード無しとして読める。壊れていたら投げる', () => {
  assert.deepEqual(parseBoard(''), { updated: null, cards: [] });
  assert.deepEqual(parseBoard('   '), { updated: null, cards: [] });
  assert.equal(parseBoard(BOARD).cards.length, 2);
  assert.throws(() => parseBoard('{ダメ'), /JSON として読めません/);
});

test('buildBoard: 空欄は落とし、created を補い、id を振る', () => {
  const r = buildBoard([{ title: 'New Plan', goal: '', detail: '  やり方  ' }], opt);
  const b = JSON.parse(r.json);
  assert.equal(b.cards.length, 1);
  assert.deepEqual(b.cards[0], { id: 'new-plan', title: 'New Plan', created: '2026-09-09', detail: 'やり方' });
  assert.match(b.updated, /^2026-09-09T\d\d:\d\d:\d\d\+09:00$/, '日本時間の壁の時計で書く');
});

test('buildBoard: 日本語だけの見出しでも id が付き、ぶつかったらずらす', () => {
  const r = buildBoard([{ title: '転職検討' }, { title: '片付け' }], opt);
  const ids = JSON.parse(r.json).cards.map(c => c.id);
  assert.deepEqual(ids, ['card', 'card-2']);
  assert.equal(new Set(ids).size, 2);
});

test('buildBoard: 見出しの改行はつぶし、本文の改行は残す', () => {
  const r = buildBoard([{ title: 'a\nb', detail: '1行目\n2行目   \n' }], opt);
  const c = JSON.parse(r.json).cards[0];
  assert.equal(c.title, 'a b');
  assert.equal(c.detail, '1行目\n2行目');
});

test('buildBoard: 長すぎる欄と、おかしな created は断る', () => {
  assert.throws(() => buildBoard([{ title: 'x', detail: 'あ'.repeat(4001) }], opt), /長すぎます/);
  assert.throws(() => buildBoard([{ title: 'x', created: '2026/09/09' }], opt), /created の形式/);
  assert.throws(() => buildBoard([{ id: 'a', title: 'x' }, { id: 'a', title: 'y' }], opt), /重複/);
});

test('setCard: id を渡せば上書き。渡さなかった欄は残る', () => {
  const r = setCard(BOARD, { id: 'toeic', detail: '金フレ→abceed' }, opt);
  assert.equal(r.added, false);
  assert.equal(r.card.title, 'TOEIC対策', '直していない欄はそのまま');
  assert.equal(r.card.goal, '11月の試験で700点');
  assert.equal(r.card.detail, '金フレ→abceed');
  assert.equal(r.card.created, '2026-08-20', '作成日は書き換えない');
  assert.equal(JSON.parse(r.json).cards.length, 2, '枚数は増えない');
});

test('setCard: 空文字を渡すとその欄が消える', () => {
  const r = setCard(BOARD, { id: 'toeic', goal: '' }, opt);
  assert.equal('goal' in r.card, false);
  assert.equal(r.card.detail, 'ルーチン型で週1枠。', '他の欄は残る');
});

test('setCard: id なしなら末尾に足す', () => {
  const r = setCard(BOARD, { title: '転職検討', purpose: '働き方を変える' }, opt);
  assert.equal(r.added, true);
  const cards = JSON.parse(r.json).cards;
  assert.equal(cards.length, 3);
  assert.equal(cards[2].title, '転職検討');
  assert.equal(cards[2].created, '2026-09-09');
  assert.deepEqual(cards.slice(0, 2).map(c => c.id), ['toeic', 'trade'], '既存の id は動かない');
});

test('setCard: 知らない id は、title があれば作り、無ければ断る', () => {
  assert.throws(() => setCard(BOARD, { id: 'nope', detail: 'x' }, opt), /そのカードがありません/);
  const r = setCard(BOARD, { id: 'nope', title: '新規' }, opt);
  assert.equal(r.added, true);
  assert.equal(r.card.id, 'nope');
});

test('removeCard: 1枚だけ消える。知らない id は断る', () => {
  const r = removeCard(BOARD, 'toeic', opt);
  assert.equal(r.card.title, 'TOEIC対策');
  assert.deepEqual(JSON.parse(r.json).cards.map(c => c.id), ['trade']);
  assert.throws(() => removeCard(BOARD, 'toeic2', opt), /そのカードがありません/);
});

test('summary: 読んだものをそのまま返す', () => {
  const s = summary(BOARD);
  assert.equal(s.count, 2);
  assert.equal(s.updated, '2026-09-01T09:00:00+09:00');
  assert.equal(s.cards[1].purpose, '収入の柱を増やす');
});
