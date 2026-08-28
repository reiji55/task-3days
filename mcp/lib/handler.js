// HTTP の入口。Vercel の関数からもローカルのテストサーバーからも同じものを使う。
// ステートレス（セッションを持たない）ので、リクエストごとに立てて閉じる。

import { timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from './server.js';

function keyMatches(given, expected) {
  if (!expected || !given) return false;
  const a = Buffer.from(String(given));
  const b = Buffer.from(String(expected));
  return a.length === b.length && timingSafeEqual(a, b);
}

function deny(res, status, message) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    jsonrpc: '2.0', error: { code: -32001, message }, id: null
  }));
}

/** ホスト側がパラメータを渡してこない場合に備えて URL からも拾う。 */
export function keyFromUrl(url = '') {
  const m = String(url).match(/\/mcp\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]) : '';
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

export async function handle(req, res, key, io) {
  if (!process.env.MCP_KEY) return deny(res, 500, 'MCP_KEY が設定されていません');
  if (!keyMatches(key || keyFromUrl(req.url), process.env.MCP_KEY)) return deny(res, 404, 'not found');

  const server = createServer(io);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,   // ステートレス
    enableJsonResponse: true         // SSE を張らず JSON で返す（サーバーレス向け）
  });

  res.on('close', () => { transport.close(); server.close(); });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, bodyOf(req));
  } catch (e) {
    if (!res.headersSent) deny(res, 500, String(e.message || e));
  }
}
