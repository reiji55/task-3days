// HTTP の入口で共通に要るもの。
//
// MCP（handler.js）とビューアの API（tasks-api.js）は別の入口だが、
// 「合言葉を突き合わせる」「本文を取り出す」はまったく同じことをしていた。
// とくに突き合わせは時間を一定に保つ必要があるので、写しが2つあると
// 片方だけ直して気づかない、が起きる。1つだけ置く。

import { timingSafeEqual } from 'node:crypto';

/**
 * 合言葉の突き合わせ。長さが同じときだけ中身を見るので、
 * どこまで一致したかが時間に出ない（総当たりの手掛かりを与えない）。
 */
export function secretMatches(given, expected) {
  if (!expected || !given) return false;
  const a = Buffer.from(String(given));
  const b = Buffer.from(String(expected));
  return a.length === b.length && timingSafeEqual(a, b);
}

/** ホストが本文を解析済みのことも、生のままのこともある。どちらでも受ける。 */
export function bodyOf(req) {
  const b = req.body;
  if (b == null) return undefined;
  if (typeof b === 'string' || Buffer.isBuffer(b)) {
    try { return JSON.parse(b.toString('utf8')); } catch { return undefined; }
  }
  return b;
}
