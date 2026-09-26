import type { MiddlewareHandler } from 'hono';

/**
 * 通用安全响应头。
 *
 * - `X-Content-Type-Options: nosniff`：阻止浏览器对 JSON 响应做 MIME 嗅探后按脚本执行；
 * - `Referrer-Policy: no-referrer`：跨域跳转时不外泄来源地址。
 *
 * 这是一个公开只读 API，不涉及 Cookie / 会话，因此无需 CSP、X-Frame-Options 等面向页面的头。
 */
const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
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
