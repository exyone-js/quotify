/**
 * Cloudflare Workers 绑定类型定义。
 * 所有绑定统一通过 `env` 访问，禁止使用 Node.js 专有 API。
 *
 * 与 `worker-configuration.d.ts` 的关系：
 * - 后者由 `npm run cf-typegen`（`wrangler types`）从 `wrangler.toml` 生成，
 *   提供字段精确（字面量类型）的全局 `Cloudflare.Env`，是「绑定真实形态」的唯一事实来源；
 * - 本文件的 `Env` 是**应用面向的视图**，刻意把限流等绑定放宽为可选，
 *   以便在本地 / 测试等未挂载全部绑定的环境中复用同一套中间件。
 *
 * 修改 `wrangler.toml` 后请重新执行 `npm run cf-typegen`，避免两者漂移。
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
  /** 数据集来源列表（JSON 字符串数组），可配置多个不同来源；缺省时用默认来源。 */
  DATA_SOURCES?: string;
  /** 缓存 TTL（秒），来自 vars 的字符串。 */
  DATA_TTL?: string;
  /** 根路径 302 重定向目标（站内绝对路径），默认 `/api/quotes/`。 */
  ROOT_REDIRECT?: string;
  /** 运行环境标识。 */
  ENVIRONMENT?: string;
};
