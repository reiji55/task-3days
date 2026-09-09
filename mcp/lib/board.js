// board.json の検証と組み立て。
//
// tasks.txt が「いま何をするか」なら、ボードは「どうやるか」。
// ルーチンの手順や、じっくり書いておきたい案件の詳細を置く読み物で、
// 日付にも3日の窓にも縛られない。ビューア（../index.html の「ボード」）が
// 読み書きし、こちらは受け取ったものを整えるだけ。
//
// 画面は入力を待たせない作りにしてある（直してから裏で書く）ので、
// 同じカードが二重に来ることがある。id を鍵にして上書きで受ける。

import { stampNow, todayKey } from './week.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX = 4000;           // 1欄の長さ。ボードは読み物なので tasks より広く取る
const MAX_CARDS = 200;

/** 見出しなどの1行もの。改行は落とす。 */
const line = (v, what) => {
  const s = String(v ?? '').replace(/[\r\n]+/g, ' ').trim();
  if (s.length > 200) throw new Error(`${what} が長すぎます（200文字まで）`);
  return s;
};

/** 本文。改行は残すが、行末の空白と過剰な長さは落とす。 */
const body = (v, what) => {
  const s = String(v ?? '').replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim();
  if (s.length > MAX) throw new Error(`${what} が長すぎます（${MAX}文字まで）`);
  return s;
};

/** タイトルから読める id を作る。日本語しかなければ通し番号にする。 */
function slug(title, taken) {
  const base = String(title || '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24)
    || 'card';
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

/** カード1枚を整える。空の欄は落とす。 */
function normalize(c, { today, taken }) {
  const title = line(c.title, 'title') || '(無題)';
  const id = line(c.id, 'id').replace(/[^A-Za-z0-9_-]/g, '') || slug(title, taken);
  const created = String(c.created ?? '').trim();
  if (created && !DATE_RE.test(created)) {
    throw new Error(`created の形式が違います: ${created}（例: 2026-09-09）`);
  }
  const out = { id, title, created: created || today };
  for (const k of ['goal', 'purpose', 'detail']) {
    const v = body(c[k], k);
    if (v) out[k] = v;
  }
  return out;
}

/** board.json を読む。空でも壊れていても、空のボードとして返さず投げる。 */
export function parseBoard(text) {
  const raw = String(text || '').trim();
  if (!raw) return { updated: null, cards: [] };
  let b;
  try { b = JSON.parse(raw); }
  catch (e) { throw new Error('board.json が JSON として読めません: ' + e.message); }
  return { updated: b.updated || null, cards: Array.isArray(b.cards) ? b.cards : [] };
}

/** カードの配列から board.json の本文を作る。 */
export function buildBoard(cards, { tz = 'Asia/Tokyo', now = new Date() } = {}) {
  const list = Array.isArray(cards) ? cards : [];
  if (list.length > MAX_CARDS) throw new Error(`カードが多すぎます（${MAX_CARDS}枚まで）`);
  const today = todayKey(tz, now);
  const taken = new Set(list.map(c => line(c && c.id, 'id')).filter(Boolean));
  const out = list.map(c => {
    const card = normalize(c || {}, { today, taken });
    taken.add(card.id);
    return card;
  });

  const seen = new Set();
  for (const c of out) {
    if (seen.has(c.id)) throw new Error(`id が重複しています: ${c.id}`);
    seen.add(c.id);
  }
  return {
    json: JSON.stringify({ updated: stampNow(tz, now), cards: out }, null, 2) + '\n',
    cards: out
  };
}

/**
 * カードを1枚だけ足す／直す。id があれば上書き、無ければ末尾に足す。
 * 渡さなかった欄は元のまま残す（title だけ直す、が普通に効く）。
 */
export function setCard(text, patch, { tz = 'Asia/Tokyo', now = new Date() } = {}) {
  const { cards } = parseBoard(text);
  const id = line(patch.id, 'id');
  const at = id ? cards.findIndex(c => c && c.id === id) : -1;
  if (id && at < 0 && !String(patch.title ?? '').trim()) {
    throw new Error(`そのカードがありません: ${id}（新しく作るなら title を渡す）`);
  }
  const merged = { ...(at >= 0 ? cards[at] : {}), ...patch };
  if (at >= 0) cards[at] = merged; else cards.push(merged);

  const built = buildBoard(cards, { tz, now });
  const card = at >= 0 ? built.cards[at] : built.cards[built.cards.length - 1];
  return { ...built, card, added: at < 0 };
}

/** カードを1枚消す。 */
export function removeCard(text, id, { tz = 'Asia/Tokyo', now = new Date() } = {}) {
  const { cards } = parseBoard(text);
  const at = cards.findIndex(c => c && c.id === id);
  if (at < 0) throw new Error(`そのカードがありません: ${id}`);
  const card = cards[at];
  cards.splice(at, 1);
  return { ...buildBoard(cards, { tz, now }), card };
}

/** 読んだ board.json をそのまま返す。カードは数が少ないので畳まない。 */
export function summary(text) {
  const { updated, cards } = parseBoard(text);
  return { updated, count: cards.length, cards };
}
