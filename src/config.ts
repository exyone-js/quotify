import type { Env } from './types/env';

/** KV 键：完整数据集（换数据结构时升版为 v2，避免旧缓存污染）。 */
export const DATA_KEY = 'epigram:data:v1';
/** KV 键：缓存元信息。 */
export const META_KEY = 'epigram:meta:v1';

/** 数据集默认地址（部署前请把 `<owner>` 换成真实 GitHub 用户名）。 */
export const DEFAULT_DATA_URL =
  'https://raw.githubusercontent.com/<owner>/epigram-data/main/data.json';

/** 缓存默认 TTL：300 秒。 */
export const DEFAULT_DATA_TTL = 300;

/** 外部 fetch 超时时间：5 秒。 */
export const FETCH_TIMEOUT_MS = 5000;

/** 回源请求在 Cloudflare 边缘缓存中的 TTL：60 秒（缓解 GitHub 限流）。 */
export const GITHUB_CACHE_TTL = 60;

/** `/api/quotes` 的 limit 区间。 */
export const RANDOM_LIMIT_MIN = 1;
export const RANDOM_LIMIT_MAX = 20;

/** `/api/quotes/search` 的 limit 区间与默认值。 */
export const SEARCH_LIMIT_MIN = 1;
export const SEARCH_LIMIT_MAX = 50;
export const SEARCH_LIMIT_DEFAULT = 10;

/** CORS 预检结果缓存时长：24 小时。 */
export const CORS_MAX_AGE = 86400;

/** 读取生效的数据集地址。 */
export function resolveDataUrl(env: Env): string {
  const url = env.DATA_URL?.trim();
  return url && url.length > 0 ? url : DEFAULT_DATA_URL;
}

/** 读取生效的缓存 TTL（秒），非法值回退到默认值。 */
export function resolveDataTtl(env: Env): number {
  const ttl = Number(env.DATA_TTL);
  return Number.isFinite(ttl) && ttl > 0 ? Math.floor(ttl) : DEFAULT_DATA_TTL;
}
