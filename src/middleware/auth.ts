import type { MiddlewareHandler } from 'hono';
import type { Env } from '../types/env';
import { ApiError } from '../utils/error';

const BEARER_PREFIX = 'Bearer ';

/**
 * 恒定时间字符串比较。
 *
 * 逐字符累积异或差（并对长度差取异或），使比较耗时与「第几个字符开始不同」无关，
 * 避免通过响应时间差逐位推断 Token。长度差异本身无法完全隐藏，
 * 但 Token 长度不属于敏感信息。
 */
function safeEqual(a: string, b: string): boolean {
  const max = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < max; i += 1) {
    // 越界时 charCodeAt 返回 NaN，`NaN | 0` 为 0，不会中断比较。
    diff |= (a.charCodeAt(i) | 0) ^ (b.charCodeAt(i) | 0);
  }
  return diff === 0;
}

/** 管理接口鉴权：`Authorization: Bearer <ADMIN_TOKEN>`。 */
export function adminAuth(): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const expected = c.env.ADMIN_TOKEN?.trim();
    if (!expected) {
      throw ApiError.internal('服务端未配置 ADMIN_TOKEN，管理接口不可用。');
    }

    const header = c.req.header('Authorization') ?? '';
    if (!header.startsWith(BEARER_PREFIX)) {
      throw ApiError.unauthorized('缺少 Authorization: Bearer <token>。');
    }

    const token = header.slice(BEARER_PREFIX.length).trim();
    if (!safeEqual(token, expected)) {
      throw ApiError.unauthorized('ADMIN_TOKEN 无效。');
    }

    await next();
  };
}
