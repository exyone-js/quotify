import type { MiddlewareHandler } from 'hono';
import { CORS_MAX_AGE } from '../config';

/** 允许任意前端跨域调用。 */
export const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': String(CORS_MAX_AGE),
};

/** 注入 CORS 头，并直接短路 OPTIONS 预检请求。 */
export function cors(): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    await next();

    for (const [key, value] of Object.entries(CORS_HEADERS)) {
      c.res.headers.set(key, value);
    }
    // 显式返回 undefined：Hono 只在拿到真值 Response 时才改 `c.res`，
    // 这里必须保留 `next()` 已经写好的响应（见 hono/dist/compose.js）。
    return undefined;
  };
}
