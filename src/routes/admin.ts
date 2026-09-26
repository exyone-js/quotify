import { Hono } from 'hono';
import { loadDatasetWithMeta, refreshAllSources } from '../data/loader';
import { collectCategories, collectTags } from '../data/store';
import { adminAuth } from '../middleware/auth';
import { adminRateLimit } from '../middleware/rateLimit';
import type { Env } from '../types/env';
import { ok } from '../utils/response';

const admin = new Hono<{ Bindings: Env }>();

admin.use('*', adminRateLimit());
admin.use('*', adminAuth());

/**
 * POST /api/admin/refresh —— 强制刷新全部来源的 KV 缓存。
 *
 * 每个来源各自「先拉取校验、成功后再覆盖自己的 KV」（`put` 会同时重置值与 TTL）。
 * 不先删键，是为了避免上游数据非法时把缓存清空、留下一个空缓存窗口。
 * 单个来源失败不影响其它来源，其错误记录在 `failures` 里；只有全部来源都失败才返回 500。
 */
admin.post('/refresh', async (c) => {
  const { dataset, loadedAt, sources, failures } = await refreshAllSources(c.env);

  return ok({
    refreshed: true,
    total: dataset.quotes.length,
    loaded_at: loadedAt,
    sources,
    failures,
  });
});

/** GET /api/admin/stats —— 数据与缓存统计（含各来源明细）。 */
admin.get('/stats', async (c) => {
  const { dataset, cached, loadedAt, sources, failures } = await loadDatasetWithMeta(c.env);

  return ok({
    total: dataset.quotes.length,
    categories: collectCategories(dataset.quotes).length,
    tags: collectTags(dataset.quotes).length,
    version: dataset.version,
    updated_at: dataset.updated_at,
    cached,
    cache_loaded_at: loadedAt,
    sources,
    failures,
  });
});

export default admin;
