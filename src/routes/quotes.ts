import { Hono, type Context } from 'hono';
import {
  CATALOG_CACHE_MAX_AGE,
  RANDOM_LIMIT_MAX,
  RANDOM_LIMIT_MIN,
  SEARCH_LIMIT_DEFAULT,
  SEARCH_LIMIT_MAX,
  SEARCH_LIMIT_MIN,
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
import type { EpigramDataset } from '../data/types';
import { publicRateLimit } from '../middleware/rateLimit';
import type { Env } from '../types/env';
import { ApiError, parseCsv, parseLimit, parseOffset } from '../utils/error';
import { cachedOk, notModified, ok, plainText } from '../utils/response';

const quotes = new Hono<{ Bindings: Env }>();

quotes.use('*', publicRateLimit());

/** 解析 format 参数，仅支持 json / text。 */
function parseFormat(raw: string | undefined): 'json' | 'text' {
  if (raw === undefined || raw === '') return 'json';
  if (raw === 'json' || raw === 'text') return raw;
  throw ApiError.badRequest("参数 format 只支持 'json' 或 'text'。");
}

/**
 * 分类 / 标签这类「同一数据集内结果稳定」的接口统一响应：
 * 命中 `If-None-Match` 返回 304，否则返回带 ETag 与 Cache-Control 的 200。
 */
function respondCatalog(
  c: Context<{ Bindings: Env }>,
  dataset: EpigramDataset,
  data: string[]
): Response {
  const etag = datasetEtag(dataset);
  if (c.req.header('If-None-Match') === etag) {
    return notModified(etag, CATALOG_CACHE_MAX_AGE);
  }
  return cachedOk(data, etag, CATALOG_CACHE_MAX_AGE);
}

/** GET /api/quotes —— 随机返回一条或多条。 */
quotes.get('/', async (c) => {
  const categories = parseCsv(c.req.query('category'), 'category');
  const tags = parseCsv(c.req.query('tag'), 'tag');
  const limit = parseLimit(c.req.query('limit'), 1, RANDOM_LIMIT_MIN, RANDOM_LIMIT_MAX);
  const format = parseFormat(c.req.query('format'));

  const { dataset } = await loadDatasetWithMeta(c.env);
  const filtered = applyFilters(dataset.epigrams, { categories, tags });
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
  const q = c.req.query('q');
  if (q === undefined || q.trim().length === 0) {
    throw ApiError.badRequest('缺少必填参数 q（至少 1 个字符）。');
  }

  const categories = parseCsv(c.req.query('category'), 'category');
  const tags = parseCsv(c.req.query('tag'), 'tag');
  const limit = parseLimit(
    c.req.query('limit'),
    SEARCH_LIMIT_DEFAULT,
    SEARCH_LIMIT_MIN,
    SEARCH_LIMIT_MAX
  );
  const offset = parseOffset(c.req.query('offset'));

  const { dataset } = await loadDatasetWithMeta(c.env);
  const matched = search(applyFilters(dataset.epigrams, { categories, tags }), q);

  return ok(paginate(matched, limit, offset));
});

/** GET /api/quotes/categories —— 所有分类（去重、字典序）。 */
quotes.get('/categories', async (c) => {
  const { dataset } = await loadDatasetWithMeta(c.env);
  return respondCatalog(c, dataset, collectCategories(dataset.epigrams));
});

/** GET /api/quotes/tags —— 所有标签（去重、字典序）。 */
quotes.get('/tags', async (c) => {
  const { dataset } = await loadDatasetWithMeta(c.env);
  return respondCatalog(c, dataset, collectTags(dataset.epigrams));
});

export default quotes;
