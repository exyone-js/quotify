import type { MiddlewareHandler } from 'hono';

/**
 * 通用安全响应头。
 *
 * - `X-Content-Type-Options: nosniff`：阻止浏览器对 JSON 响应做 MIME 嗅探后按脚本执行；
 * - `Referrer-Policy: no-referrer`：跨域跳转时不外泄来源地址；
 * - `X-Frame-Options: DENY`：响应体是 JSON，没有任何合法嵌入场景；
 * - `Cross-Origin-Resource-Policy: cross-origin`：明确允许跨站读取，
 *   避免将来启用 CORP 默认值（`same-origin`）时把既有调用方挡在外面。
 *
 * 这是一个公开只读 API，不涉及 Cookie / 会话与用户脚本执行，
 * 因此不设 CSP / HSTS（后者应由自定义域的边缘设置负责）。
 */
const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Resource-Policy': 'cross-origin',
};

/** 为所有响应（含错误、重定向与 304）注入安全响应头。 */
export function securityHeaders(): MiddlewareHandler {
  return async (c, next) => {
    await next();

    for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
      c.res.headers.set(key, value);
    }
  };
}
