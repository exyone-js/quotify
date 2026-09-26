import { Hono } from 'hono';
import { resolveDataUrl } from '../config';
import { fetchAndCache, loadDatasetWithMeta } from '../data/loader';
import { collectCategories, collectTags } from '../data/store';
import { adminAuth } from '../middleware/auth';
import { adminRateLimit } from '../middleware/rateLimit';
import type { Env } from '../types/env';
import { ok } from '../utils/response';

const admin = new Hono<{ Bindings: Env }>();

admin.use('*', adminRateLimit());
admin.use('*', adminAuth());

/**
 * POST /api/admin/refresh —— 强制刷新 KV 缓存。
 *
 * 先拉取并校验，成功后再覆盖 KV（`put` 会同时重置值与 TTL）。
 * 不先删键，是为了避免上游数据非法时把缓存清空、留下一个空缓存窗口。
 */
admin.post('/refresh', async (c) => {
  const { dataset, loadedAt } = await fetchAndCache(c.env);

  return ok({
    refreshed: true,
    total: dataset.epigrams.length,
    loaded_at: loadedAt,
    source_url: resolveDataUrl(c.env),
  });
});

/** GET /api/admin/stats —— 数据与缓存统计。 */
admin.get('/stats', async (c) => {
  const { dataset, cached, loadedAt } = await loadDatasetWithMeta(c.env);

  return ok({
    total: dataset.epigrams.length,
    categories: collectCategories(dataset.epigrams).length,
    tags: collectTags(dataset.epigrams).length,
    version: dataset.version,
    updated_at: dataset.updated_at,
    cached,
    cache_loaded_at: loadedAt,
  });
});

export default admin;
