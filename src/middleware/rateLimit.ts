import type { MiddlewareHandler } from 'hono';
import type { Env, RateLimitBinding } from '../types/env';
import { ApiError } from '../utils/error';

/** 提取客户端标识用于限流分桶。 */
function clientKey(headers: Headers): string {
  return headers.get('CF-Connecting-IP') ?? headers.get('x-forwarded-for') ?? 'anonymous';
}

async function enforce(
  limiter: RateLimitBinding | undefined,
  bucket: string,
  key: string
): Promise<void> {
  // 本地/测试环境可能没有 ratelimits 绑定，此时直接放行而不是报错。
  if (!limiter) return;

  const { success } = await limiter.limit({ key: `${bucket}:${key}` });
  if (!success) {
    throw ApiError.tooManyRequests();
  }
}

/** 公开接口：60 次 / 分钟 / IP。 */
export function publicRateLimit(): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    await enforce(c.env.PUBLIC_RATE_LIMITER, 'public', clientKey(c.req.raw.headers));
    await next();
  };
}

/** 管理接口：10 次 / 分钟 / IP。 */
export function adminRateLimit(): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    await enforce(c.env.ADMIN_RATE_LIMITER, 'admin', clientKey(c.req.raw.headers));
    await next();
  };
}
