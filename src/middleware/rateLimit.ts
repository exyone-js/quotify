import type { MiddlewareHandler } from 'hono';
import type { Env, RateLimitBinding } from '../types/env';
import { ApiError } from '../utils/error';

/**
 * 提取客户端标识用于限流分桶。
 *
 * **只信任 `CF-Connecting-IP`**：它由 Cloudflare 边缘写入，客户端无法伪造。
 * 绝不能回退到 `x-forwarded-for` 之类的请求头——那是客户端完全可控的，
 * 只要轮换该头就能绕过限流（进而爆破管理接口的 Token）。
 * 取不到时统一归到 `anonymous` 桶（宁可共享配额，也不放开伪造入口）。
 */
function clientKey(headers: Headers): string {
  return headers.get('CF-Connecting-IP') ?? 'anonymous';
}

async function enforce(
  limiter: RateLimitBinding | undefined,
  bucket: string,
  key: string,
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

/**
 * 宽松限流：用于 `/`（重定向）与 `/api/health` 这类低成本入口。
 *
 * 它们不读数据集，成本远低于随机接口，但仍要挡住低成本的放大 / 探测流量。
 * 绑定缺失时同样放行。
 */
export function looseRateLimit(): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    await enforce(c.env.HEALTH_RATE_LIMITER, 'loose', clientKey(c.req.raw.headers));
    await next();
  };
}
