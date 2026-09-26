import {
  DATA_KEY,
  FETCH_TIMEOUT_MS,
  GITHUB_CACHE_TTL,
  MEMORY_CACHE_TTL_MS,
  META_KEY,
  resolveDataTtl,
  resolveDataUrl,
} from '../config';
import type { Env } from '../types/env';
import { UpstreamError } from '../utils/error';
import type { DatasetMeta, Epigram, EpigramDataset } from './types';

/** 加载结果：数据集本身 + 是否命中缓存 + 缓存写入时间。 */
export interface LoadResult {
  dataset: EpigramDataset;
  cached: boolean;
  loadedAt: number | null;
}

/** KV 快照：在 LoadResult 之上额外保留原始文本与上游 ETag，供条件请求复用。 */
interface CacheSnapshot {
  dataset: EpigramDataset;
  /** 写入 KV 的原始 JSON 文本；304 续期时原样回写，避免重新序列化。 */
  raw: string;
  loadedAt: number | null;
  etag: string | null;
}

/** 进程内热缓存条目。 */
interface MemoryEntry {
  result: LoadResult;
  expiresAt: number;
  /** 记录来源地址，DATA_URL 变更后立即失效。 */
  sourceUrl: string;
}

let memory: MemoryEntry | null = null;

/**
 * 清空进程内热缓存。
 *
 * 热缓存以 isolate 为单位，无法跨 isolate 全局失效，因此它只用于
 * 「避免每个请求都重复读 KV 并全量解析数据集」，不承担一致性保证。
 * 管理端刷新后由调用方显式清掉当前 isolate 的副本。
 */
export function invalidateMemoryCache(): void {
  memory = null;
}

/** 读取命中的热缓存：来源地址不一致或已过期都视为未命中。 */
function readMemory(sourceUrl: string): LoadResult | null {
  if (memory === null || memory.sourceUrl !== sourceUrl || memory.expiresAt <= Date.now()) {
    return null;
  }
  return memory.result;
}

/** 写入热缓存并返回原结果，便于链式返回。 */
function writeMemory(result: LoadResult, sourceUrl: string): LoadResult {
  memory = { result, expiresAt: Date.now() + MEMORY_CACHE_TTL_MS, sourceUrl };
  return result;
}

/** 读取可选字符串字段：缺省合法；类型错误直接抛错（避免下游出现隐式 TypeError）。 */
function readOptionalString(
  record: Record<string, unknown>,
  key: string,
  index: number
): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new UpstreamError(`数据集格式非法：第 ${index} 条记录的 ${key} 必须是字符串。`);
  }
  return value;
}

/** 读取可选 tags 字段：必须是字符串数组，否则抛错。 */
function readOptionalTags(record: Record<string, unknown>, index: number): string[] | undefined {
  const value = record.tags;
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || !value.every((tag) => typeof tag === 'string')) {
    throw new UpstreamError(`数据集格式非法：第 ${index} 条记录的 tags 必须是字符串数组。`);
  }
  return value as string[];
}

/**
 * 校验数据集结构。非法数据直接抛错（由顶层转成 500），不静默丢弃。
 *
 * 这里做的是「校验 + 归一」：只保留已知字段，缺失的可选字段置为 undefined，
 * 因此返回值可以安全地当作 `Epigram` 使用，无需下游再做类型兜底。
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

    const id = record.id;
    if (typeof id !== 'string' || id.length === 0) {
      throw new UpstreamError(`数据集格式非法：第 ${index} 条记录缺少 id。`);
    }
    const content = record.content;
    if (typeof content !== 'string' || content.length === 0) {
      throw new UpstreamError(`数据集格式非法：第 ${index} 条记录缺少 content。`);
    }

    return {
      id,
      content,
      source: readOptionalString(record, 'source', index),
      author: readOptionalString(record, 'author', index),
      category: readOptionalString(record, 'category', index),
      tags: readOptionalTags(record, index),
    };
  });

  return {
    version: root.version,
    updated_at: typeof root.updated_at === 'string' ? root.updated_at : '',
    epigrams,
  };
}

/** 把上游原始文本解析为数据集：JSON 解析失败与结构非法都归一为 UpstreamError。 */
export function parseDataset(raw: string): EpigramDataset {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new UpstreamError(`数据集不是合法 JSON：${reason}`);
  }
  return validateDataset(parsed);
}

/** 解析缓存元信息；缺失或损坏时返回空值（只影响展示与条件请求，不影响数据本身）。 */
function parseMeta(metaRaw: string | null): { loadedAt: number | null; etag: string | null } {
  if (metaRaw === null) return { loadedAt: null, etag: null };
  try {
    const { loaded_at: loadedAt, etag } = JSON.parse(metaRaw) as Partial<DatasetMeta>;
    return {
      loadedAt: typeof loadedAt === 'number' ? loadedAt : null,
      etag: typeof etag === 'string' && etag.length > 0 ? etag : null,
    };
  } catch {
    return { loadedAt: null, etag: null };
  }
}

/** 读取 KV 快照：不存在返回 null；损坏则连同元信息清理并返回 null（触发回源）。 */
async function readSnapshot(env: Env): Promise<CacheSnapshot | null> {
  // 数据集与元信息并发读取，避免两次串行的 KV 往返。
  const [raw, metaRaw] = await Promise.all([
    env.CACHE.get(DATA_KEY),
    env.CACHE.get(META_KEY),
  ]);
  if (raw === null) return null;

  try {
    const { loadedAt, etag } = parseMeta(metaRaw);
    return { dataset: validateDataset(JSON.parse(raw)), raw, loadedAt, etag };
  } catch (err) {
    console.error('KV 缓存损坏，已删除并回源：', err);
    await Promise.all([env.CACHE.delete(DATA_KEY), env.CACHE.delete(META_KEY)]);
    return null;
  }
}

/** 上游响应：状态码、正文（304 时为 null）与 ETag。 */
interface UpstreamResponse {
  status: number;
  text: string | null;
  etag: string | null;
}

/**
 * 带 5 秒超时与边缘缓存的上游请求。
 * 传入 etag 时会带上 `If-None-Match`，上游未变更将返回 304，从而省去正文下载。
 */
async function fetchUpstream(url: string, etag: string | null): Promise<UpstreamResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const headers: Record<string, string> = {
      'User-Agent': 'epigram-worker',
      Accept: 'application/json',
    };
    if (etag !== null) headers['If-None-Match'] = etag;

    const res = await fetch(url, {
      headers,
      signal: controller.signal,
      cf: { cacheTtl: GITHUB_CACHE_TTL, cacheEverything: true },
    });

    if (res.status === 304) {
      return { status: 304, text: null, etag };
    }
    if (!res.ok) {
      throw new UpstreamError(`拉取数据集失败：上游返回 ${res.status}。`);
    }
    return { status: res.status, text: await res.text(), etag: res.headers.get('ETag') };
  } catch (err) {
    if (err instanceof UpstreamError) throw err;
    const reason = err instanceof Error ? err.message : String(err);
    throw new UpstreamError(`拉取数据集失败：${reason}`);
  } finally {
    clearTimeout(timer);
  }
}

/** 回写数据集与元信息（同时重置 TTL）。 */
async function writeCache(
  env: Env,
  url: string,
  raw: string,
  loadedAt: number,
  etag: string | null
): Promise<void> {
  const ttl = resolveDataTtl(env);
  const meta: DatasetMeta = { loaded_at: loadedAt, source_url: url };
  if (etag !== null) meta.etag = etag;

  await Promise.all([
    env.CACHE.put(DATA_KEY, raw, { expirationTtl: ttl }),
    env.CACHE.put(META_KEY, JSON.stringify(meta), { expirationTtl: ttl }),
  ]);
}

/**
 * 基于已有快照回源：
 * - 上游 304 → 复用缓存数据，仅续期 KV（省去解析与重写正文）；
 * - 上游 200 → 校验通过后重新写入；校验失败直接抛错，不污染缓存。
 */
async function refreshFromUpstream(
  env: Env,
  url: string,
  snapshot: CacheSnapshot | null
): Promise<LoadResult> {
  const upstream = await fetchUpstream(url, snapshot?.etag ?? null);

  if (upstream.status === 304) {
    if (snapshot === null) {
      // 没有本地数据时不会携带 If-None-Match，理论上不可达；显式兜底避免死循环。
      throw new UpstreamError('上游返回 304，但本地没有可用缓存。');
    }
    const loadedAt = snapshot.loadedAt ?? Date.now();
    await writeCache(env, url, snapshot.raw, loadedAt, snapshot.etag);
    return writeMemory({ dataset: snapshot.dataset, cached: true, loadedAt }, url);
  }

  const raw = upstream.text ?? '';
  const dataset = parseDataset(raw);
  const loadedAt = Date.now();
  await writeCache(env, url, raw, loadedAt, upstream.etag);
  return writeMemory({ dataset, cached: false, loadedAt }, url);
}

/**
 * 强制回源刷新（管理端 `/refresh` 使用）。
 * 校验失败时直接抛错，不会把脏数据写入缓存。
 */
export async function fetchAndCache(env: Env): Promise<LoadResult> {
  const url = resolveDataUrl(env);
  return refreshFromUpstream(env, url, await readSnapshot(env));
}

/**
 * 策略 A（懒加载）：热缓存 → KV → 回源，逐级兜底。
 *
 * `cached` 语义为「本次未回源上游」：命中热缓存或 KV 均为 true，
 * 仅当刚刚拉取到上游新数据后才为 false。
 */
export async function loadDatasetWithMeta(env: Env): Promise<LoadResult> {
  const url = resolveDataUrl(env);

  const hot = readMemory(url);
  if (hot !== null) return { ...hot, cached: true };

  const snapshot = await readSnapshot(env);
  if (snapshot !== null) {
    return writeMemory(
      { dataset: snapshot.dataset, cached: true, loadedAt: snapshot.loadedAt },
      url
    );
  }
  return refreshFromUpstream(env, url, null);
}

/** 只需要数据集时的便捷封装。 */
export async function loadDataset(env: Env): Promise<EpigramDataset> {
  const { dataset } = await loadDatasetWithMeta(env);
  return dataset;
}

/** 只读缓存状态（不触发回源），供健康检查使用；优先命中热缓存以避免重复解析。 */
export async function peekCache(
  env: Env
): Promise<{ cached: boolean; loadedAt: number | null; total: number }> {
  const hot = readMemory(resolveDataUrl(env));
  if (hot !== null) {
    return { cached: true, loadedAt: hot.loadedAt, total: hot.dataset.epigrams.length };
  }

  const snapshot = await readSnapshot(env);
  if (snapshot === null) return { cached: false, loadedAt: null, total: 0 };
  return { cached: true, loadedAt: snapshot.loadedAt, total: snapshot.dataset.epigrams.length };
}
