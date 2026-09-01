// ビューア（GitHub Pages）から呼ばれる、tasks.txt の読み書き口。
//
// ここが GITHUB_TOKEN を持ち、ブラウザには渡さない。
// ブラウザが持つのは EDIT_PIN（短い数字）だけ。トークンが端末から
// 消える／端末ごとに入れ直す、という問題がこれで無くなる。

import { timingSafeEqual } from 'node:crypto';
import { readTasks, writeTasks, checkAccess } from './github.js';

const MAX_BYTES = 200_000;   // tasks.txt は数KB。桁違いに大きいものは弾く

const allowedOrigin = () => process.env.ALLOW_ORIGIN || 'https://reiji55.github.io';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin());
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Pin');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Vary', 'Origin');
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function pinMatches(given, expected) {
  if (!expected || !given) return false;
  const a = Buffer.from(String(given));
  const b = Buffer.from(String(expected));
  return a.length === b.length && timingSafeEqual(a, b);
}

/** ホストが本文を解析済みのことも、生のままのこともある。どちらでも受ける。 */
function bodyOf(req) {
  const b = req.body;
  if (b == null) return undefined;
  if (typeof b === 'string' || Buffer.isBuffer(b)) {
    try { return JSON.parse(b.toString('utf8')); } catch { return undefined; }
  }
  return b;
}

export function createTasksApi(io = { readTasks, writeTasks, checkAccess }, { sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  return async function handler(req, res) {
    setCors(res);

    if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
    if (req.method !== 'GET' && req.method !== 'PUT') {
      return send(res, 405, { error: 'GET か PUT のみ' });
    }
    if (!process.env.EDIT_PIN) {
      return send(res, 503, { error: 'EDIT_PIN が設定されていません' });
    }

    const url = new URL(req.url || '/', 'http://x');
    const given = req.headers['x-pin'] || url.searchParams.get('pin');
    if (!pinMatches(given, process.env.EDIT_PIN)) {
      await sleep(400);              // 総当たりの速度を落とす
      return send(res, 401, { error: '暗証番号が違います' });
    }

    try {
      if (req.method === 'GET') {
        // ?check=1 … トークンで何ができるかだけ見る。ファイルには触らない
        if (url.searchParams.get('check')) {
          return send(res, 200, await (io.checkAccess || checkAccess)());
        }
        const { text, sha } = await io.readTasks();
        return send(res, 200, { text, sha });
      }

      const body = bodyOf(req) || {};
      if (typeof body.text !== 'string') return send(res, 400, { error: 'text がありません' });
      if (Buffer.byteLength(body.text, 'utf8') > MAX_BYTES) return send(res, 413, { error: '大きすぎます' });
      if (!body.sha) return send(res, 400, { error: 'sha がありません' });

      const sha = await io.writeTasks(body.text, body.sha, body.message || 'tasks: 更新');
      return send(res, 200, { sha });
    } catch (e) {
      const msg = String(e.message || e);
      const status = /先に更新されていました/.test(msg) ? 409
                   : /GITHUB_TOKEN/.test(msg) ? 500
                   : 502;
      return send(res, status, { error: msg });
    }
  };
}
