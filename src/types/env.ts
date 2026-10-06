/**
 * Cloudflare Workers 绑定类型定义。
 * 所有绑定统一通过 `env` 访问，禁止使用 Node.js 专有 API。
 *
 * 与 `worker-configuration.d.ts` 的关系：
 * - 后者由 `npm run cf-typegen`（`wrangler types`）从 `wrangler.toml` 生成，
 *   提供 Workers 运行时全局类型与 `Cloudflare.Env`（字段为字面量类型）；
 * - 本文件的 `Env` 是**应用面向的唯一契约**，刻意把限流等绑定放宽为可选，
 *   以便在本地 / 测试等未挂载全部绑定的环境中复用同一套中间件。
 *
 * 业务代码一律 `import type { Env } from './types/env'`，不要用生成的 `Cloudflare.Env`：
 * 后者会随 `wrangler.toml` 变化重新生成，是不稳定的实现细节。
 * `worker-configuration.d.ts` 只在 CI 中生成（见 `.github/workflows/ci.yml`），
 * 本地修改 `wrangler.toml` 后请重新执行 `npm run cf-typegen`。
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
  /** 宽松限流绑定：用于 `/` 与 `/api/health`（缺省时自动放行）。 */
  HEALTH_RATE_LIMITER?: RateLimitBinding;
  /**
   * 管理接口 Bearer Token，通过 `wrangler secret put ADMIN_TOKEN` 注入。
   * **不要把默认值写进 `wrangler.toml`**：忘记注入时管理接口会直接 500 并打告警，
   * 这比「带着一个公开已知的 Token 上线」安全得多。
   */
  ADMIN_TOKEN?: string;
  /** 数据集来源列表（JSON 字符串数组），可配置多个不同来源；缺省时用默认来源。 */
  DATA_SOURCES?: string;
  /**
   * 可选的「来源清单」地址：一个 JSON 字符串数组，元素是数据集 URL。
   * 配置后可在不改动 / 不重新部署 Worker 的情况下动态增减来源。
   */
  DATA_MANIFEST_URL?: string;
  /** 缓存 TTL（秒），来自 vars 的字符串。 */
  DATA_TTL?: string;
  /**
   * 可选的来源主机白名单（逗号分隔）。未配置时不限制主机；
   * 配置后，来源清单里解析出的地址必须命中白名单才允许加载（防 SSRF）。
   */
  DATA_SOURCE_HOSTS?: string;
  /** 根路径 302 重定向目标（站内绝对路径），默认 `/api/quotes/`。 */
  ROOT_REDIRECT?: string;
  /** 运行环境标识。 */
  ENVIRONMENT?: string;
};
