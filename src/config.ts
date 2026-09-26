import type { Env } from './types/env';

/** KV 键：完整数据集（换数据结构时升版为 v2，避免旧缓存污染）。 */
export const DATA_KEY = 'epigram:data:v1';
/** KV 键：缓存元信息。 */
export const META_KEY = 'epigram:meta:v1';

/** 数据集默认地址；与 `wrangler.toml` 的 `DATA_URL` 保持一致。 */
export const DEFAULT_DATA_URL =
  'https://raw.githubusercontent.com/exyone-js/epigram-data/main/data.json';

/** 缓存默认 TTL：300 秒。 */
export const DEFAULT_DATA_TTL = 300;

/** 进程内热缓存 TTL：60 秒。用于避免每个请求都重复读 KV 并全量解析数据集。 */
export const MEMORY_CACHE_TTL_MS = 60_000;

/** 外部 fetch 超时时间：5 秒。 */
export const FETCH_TIMEOUT_MS = 5000;

/** 回源请求在 Cloudflare 边缘缓存中的 TTL：60 秒（缓解 GitHub 限流）。 */
export const GITHUB_CACHE_TTL = 60;

/** 逗号分隔参数允许的最大取值个数，避免超长参数放大过滤开销。 */
export const MAX_CSV_VALUES = 50;

/** 内容稳定的派生接口（分类 / 标签）的浏览器 / CDN 缓存时长：1 小时。 */
export const CATALOG_CACHE_MAX_AGE = 3600;

/** `/api/quotes` 的 limit 区间。 */
export const RANDOM_LIMIT_MIN = 1;
export const RANDOM_LIMIT_MAX = 20;

/** `/api/quotes/search` 的 limit 区间与默认值。 */
export const SEARCH_LIMIT_MIN = 1;
export const SEARCH_LIMIT_MAX = 50;
export const SEARCH_LIMIT_DEFAULT = 10;

/** CORS 预检结果缓存时长：24 小时。 */
export const CORS_MAX_AGE = 86400;

/**
 * 根路径默认重定向目标。访问根域时直接跳到公开随机一言接口，
 * 避免用户看到裸 404。必须是以单个 `/` 开头的站内绝对路径。
 */
export const DEFAULT_ROOT_REDIRECT = '/api/quotes/';

/** 读取生效的数据集地址。 */
export function resolveDataUrl(env: Env): string {
  const url = env.DATA_URL?.trim();
  return url && url.length > 0 ? url : DEFAULT_DATA_URL;
}

/**
 * 读取生效的根路径重定向目标。
 *
 * 只接受站内绝对路径（以 `/` 开头且不以 `//` 开头），否则回退到默认值：
 * 避免配置被写成外链时形成开放重定向（Open Redirect）。
 */
export function resolveRootRedirect(env: Env): string {
  const target = env.ROOT_REDIRECT?.trim();
  if (!target || !target.startsWith('/') || target.startsWith('//')) {
    return DEFAULT_ROOT_REDIRECT;
  }
  return target;
}

/** 读取生效的缓存 TTL（秒），非法值回退到默认值。 */
export function resolveDataTtl(env: Env): number {
  const ttl = Number(env.DATA_TTL);
  return Number.isFinite(ttl) && ttl > 0 ? Math.floor(ttl) : DEFAULT_DATA_TTL;
}
