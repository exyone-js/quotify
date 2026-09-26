/**
 * Cloudflare Workers 绑定类型定义。
 * 所有绑定统一通过 `env` 访问，禁止使用 Node.js 专有 API。
 */

/** 速率限制绑定（Cloudflare Rate Limiting Binding）的返回值。 */
export interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

// 使用 type 而非 interface：Hono 的 `Bindings` 约束为 `Record<string, any>`，
// 类型别名带隐式索引签名，可直接满足约束。
export type Env = {
  /** KV 命名空间：缓存整份数据集与元信息。 */
  CACHE: KVNamespace;
  /** 公开接口限流绑定（缺省时中间件自动放行）。 */
  PUBLIC_RATE_LIMITER?: RateLimitBinding;
  /** 管理接口限流绑定（缺省时中间件自动放行）。 */
  ADMIN_RATE_LIMITER?: RateLimitBinding;
  /** 管理接口 Bearer Token，通过 `wrangler secret put ADMIN_TOKEN` 注入。 */
  ADMIN_TOKEN?: string;
  /** 数据集原始地址（GitHub raw）。 */
  DATA_URL?: string;
  /** 缓存 TTL（秒），来自 vars 的字符串。 */
  DATA_TTL?: string;
  /** 运行环境标识。 */
  ENVIRONMENT?: string;
};
