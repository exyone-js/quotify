import { Hono, type Context } from 'hono';
import {
  CATALOG_CACHE_MAX_AGE,
  RANDOM_LIMIT_MAX,
  RANDOM_LIMIT_MIN,
  SEARCH_LIMIT_DEFAULT,
  SEARCH_LIMIT_MAX,
  SEARCH_LIMIT_MIN,
  resolveDataTtl,
} from '../config';
import { loadDatasetWithMeta } from '../data/loader';
import {
  applyFilters,
  collectCategories,
  collectTags,
  datasetEtag,
  paginate,
  randomPick,
  search,
} from '../data/store';
import type { QuoteDataset } from '../data/types';
import { publicRateLimit } from '../middleware/rateLimit';
import type { Env } from '../types/env';
import { ApiError, parseCsv, parseLimit, parseOffset, parseText } from '../utils/error';
import { cachedOk, etagMatches, notModified, ok, plainText } from '../utils/response';

const quotes = new Hono<{ Bindings: Env }>();

quotes.use('*', publicRateLimit());

/**
 * 派生接口的浏览器 / CDN 缓存时长。
 *
 * 与数据集 TTL 取小：数据集最快会在 `DATA_TTL` 秒后被刷新，
 * 若客户端缓存得比它还久，就会一直看到旧分类 / 旧标签。
 */
function catalogMaxAge(env: Env): number {
  return Math.min(CATALOG_CACHE_MAX_AGE, resolveDataTtl(env));
}

/** 解析 format 参数，仅支持 json / text。 */
function parseFormat(raw: string | undefined): 'json' | 'text' {
  if (raw === undefined || raw === '') return 'json';
  if (raw === 'json' || raw === 'text') return raw;
  throw ApiError.badRequest("参数 format 只支持 'json' 或 'text'。");
}

/**
 * 分类 / 标签这类「同一数据集内结果稳定」的接口统一响应：
 * 命中 `If-None-Match` 返回 304，否则返回带 ETag 与 Cache-Control 的 200。
 *
 * ETag 比较用宽松匹配（容忍 `W/` 前缀、多值列表与代理加的后缀），
 * 否则客户端回传的等价 ETag 命中不了 304。
 */
function respondCatalog(
  c: Context<{ Bindings: Env }>,
  dataset: QuoteDataset,
  data: string[],
): Response {
  const etag = datasetEtag(dataset);
  const maxAge = catalogMaxAge(c.env);
  if (etagMatches(c.req.header('If-None-Match'), etag)) {
    return notModified(etag, maxAge);
  }
  return cachedOk(data, etag, maxAge);
}

/** GET /api/quotes —— 随机返回一条或多条。 */
quotes.get('/', async (c) => {
  const categories = parseCsv(c.req.query('category'), 'category');
  const tags = parseCsv(c.req.query('tag'), 'tag');
  const limit = parseLimit(c.req.query('limit'), 1, RANDOM_LIMIT_MIN, RANDOM_LIMIT_MAX);
  const format = parseFormat(c.req.query('format'));

  const { dataset } = await loadDatasetWithMeta(c.env);
  const filtered = applyFilters(dataset.quotes, { categories, tags });
  if (filtered.length === 0) {
    throw ApiError.notFound('没有符合条件的一言。');
  }

  const picked = randomPick(filtered, limit);
  if (format === 'text') {
    return plainText(picked.map((item) => item.content).join('\n'));
  }
  return ok(picked);
});

/** GET /api/quotes/search —— 关键词搜索 + 分类/标签过滤 + 分页。 */
quotes.get('/search', async (c) => {
  const q = parseText(c.req.query('q'), 'q');
  if (q.length === 0) {
    throw ApiError.badRequest('缺少必填参数 q（至少 1 个字符）。');
  }

  const categories = parseCsv(c.req.query('category'), 'category');
  const tags = parseCsv(c.req.query('tag'), 'tag');
  const limit = parseLimit(
    c.req.query('limit'),
    SEARCH_LIMIT_DEFAULT,
    SEARCH_LIMIT_MIN,
    SEARCH_LIMIT_MAX,
  );
  const offset = parseOffset(c.req.query('offset'));

  const { dataset } = await loadDatasetWithMeta(c.env);
  const matched = search(applyFilters(dataset.quotes, { categories, tags }), q);

  return ok(paginate(matched, limit, offset));
});

/** GET /api/quotes/categories —— 所有分类（去重、字典序）。 */
quotes.get('/categories', async (c) => {
  const { dataset } = await loadDatasetWithMeta(c.env);
  return respondCatalog(c, dataset, collectCategories(dataset.quotes));
});

/** GET /api/quotes/tags —— 所有标签（去重、字典序）。 */
quotes.get('/tags', async (c) => {
  const { dataset } = await loadDatasetWithMeta(c.env);
  return respondCatalog(c, dataset, collectTags(dataset.quotes));
});

export default quotes;
