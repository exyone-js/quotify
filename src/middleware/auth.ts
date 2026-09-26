import type { MiddlewareHandler } from 'hono';
import type { Env } from '../types/env';
import { ApiError } from '../utils/error';

const BEARER_PREFIX = 'Bearer ';

/** 管理接口鉴权：`Authorization: Bearer <ADMIN_TOKEN>`。 */
export function adminAuth(): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const expected = c.env.ADMIN_TOKEN;
    if (!expected) {
      throw ApiError.internal('服务端未配置 ADMIN_TOKEN，管理接口不可用。');
    }

    const header = c.req.header('Authorization') ?? '';
    if (!header.startsWith(BEARER_PREFIX)) {
      throw ApiError.unauthorized('缺少 Authorization: Bearer <token>。');
    }

    const token = header.slice(BEARER_PREFIX.length).trim();
    if (token !== expected.trim()) {
      throw ApiError.unauthorized('ADMIN_TOKEN 无效。');
    }

    await next();
  };
}
