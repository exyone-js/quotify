import { DATA_KEY, META_KEY, FETCH_TIMEOUT_MS, GITHUB_CACHE_TTL, resolveDataTtl, resolveDataUrl } from '../config';
import type { Env } from '../types/env';
import { UpstreamError } from '../utils/error';
import type { DatasetMeta, Epigram, EpigramDataset } from './types';

/** 加载结果：数据集本身 + 是否命中缓存 + 缓存写入时间。 */
export interface LoadResult {
  dataset: EpigramDataset;
  cached: boolean;
  loadedAt: number | null;
}

/**
 * 校验数据集结构。非法数据直接抛错（由顶层转成 500），不静默丢弃。
 */
export function validateDataset(input: unknown): EpigramDataset {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new UpstreamError('数据集格式非法：根节点必须是对象。');
  }

  const root = input as Record<string, unknown>;

  if (typeof root.version !== 'number' || !Number.isFinite(root.version)) {
    throw new UpstreamError('数据集格式非法：version 必须是数字。');
  }
  if (!Array.isArray(root.epigrams)) {
    throw new UpstreamError('数据集格式非法：epigrams 必须是数组。');
  }

  const epigrams: Epigram[] = root.epigrams.map((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new UpstreamError(`数据集格式非法：第 ${index} 条记录不是对象。`);
    }
    const record = item as Record<string, unknown>;
    if (typeof record.id !== 'string' || record.id.length === 0) {
      throw new UpstreamError(`数据集格式非法：第 ${index} 条记录缺少 id。`);
    }
    if (typeof record.content !== 'string' || record.content.length === 0) {
      throw new UpstreamError(`数据集格式非法：第 ${index} 条记录缺少 content。`);
    }
    return record as unknown as Epigram;
  });

  return {
    version: root.version,
    updated_at: typeof root.updated_at === 'string' ? root.updated_at : '',
    epigrams,
  };
}

async function readCache(env: Env): Promise<LoadResult | null> {
  const cached = await env.CACHE.get(DATA_KEY);
  if (cached === null) return null;

  try {
    const dataset = validateDataset(JSON.parse(cached));
    const metaRaw = await env.CACHE.get(META_KEY);
    let loadedAt: number | null = null;
    if (metaRaw !== null) {
      try {
        loadedAt = (JSON.parse(metaRaw) as DatasetMeta).loaded_at ?? null;
      } catch {
        loadedAt = null;
      }
    }
    return { dataset, cached: true, loadedAt };
  } catch (err) {
    // 缓存损坏：删除后回源，避免持续返回错误数据。
    console.error('KV 缓存损坏，已删除并回源：', err);
    await env.CACHE.delete(DATA_KEY);
    return null;
  }
}

/** 带 5 秒超时与边缘缓存的外网请求。 */
async function fetchDatasetText(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'epigram-worker', Accept: 'application/json' },
      signal: controller.signal,
      cf: { cacheTtl: GITHUB_CACHE_TTL, cacheEverything: true },
    });
    if (!res.ok) {
      throw new UpstreamError(`拉取数据集失败：上游返回 ${res.status}。`);
    }
    return await res.text();
  } catch (err) {
    if (err instanceof UpstreamError) throw err;
    const reason = err instanceof Error ? err.message : String(err);
    throw new UpstreamError(`拉取数据集失败：${reason}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 强制从 GitHub 拉取数据集并回写 KV。
 * 校验失败时直接抛错，不会把脏数据写入缓存。
 */
export async function fetchAndCache(env: Env): Promise<LoadResult> {
  const url = resolveDataUrl(env);
  const raw = await fetchDatasetText(url);
  const dataset = validateDataset(JSON.parse(raw));
  const loadedAt = Date.now();

  await Promise.all([
    env.CACHE.put(DATA_KEY, raw, { expirationTtl: resolveDataTtl(env) }),
    env.CACHE.put(
      META_KEY,
      JSON.stringify({ loaded_at: loadedAt, source_url: url } satisfies DatasetMeta),
      { expirationTtl: resolveDataTtl(env) }
    ),
  ]);

  return { dataset, cached: false, loadedAt };
}

/**
 * 策略 A（懒加载）：先读 KV，命中即返回；未命中或过期时回源并回写 KV。
 */
export async function loadDatasetWithMeta(env: Env): Promise<LoadResult> {
  const cached = await readCache(env);
  if (cached !== null) return cached;
  return fetchAndCache(env);
}

/** 只需要数据集时的便捷封装。 */
export async function loadDataset(env: Env): Promise<EpigramDataset> {
  const { dataset } = await loadDatasetWithMeta(env);
  return dataset;
}

/** 只读缓存状态（不触发回源），供健康检查使用。 */
export async function peekCache(
  env: Env
): Promise<{ cached: boolean; loadedAt: number | null; total: number }> {
  const result = await readCache(env);
  if (result === null) return { cached: false, loadedAt: null, total: 0 };
  return {
    cached: true,
    loadedAt: result.loadedAt,
    total: result.dataset.epigrams.length,
  };
}
