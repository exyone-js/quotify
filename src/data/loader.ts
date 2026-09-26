import {
  FETCH_TIMEOUT_MS,
  GITHUB_CACHE_TTL,
  MEMORY_CACHE_TTL_MS,
  dataKey,
  metaKey,
  resolveDataSources,
  resolveDataTtl,
} from '../config';
import type { Env } from '../types/env';
import { UpstreamError } from '../utils/error';
import type { DatasetMeta, Quote, QuoteDataset } from './types';

/** 某个来源的加载状态（对外可序列化，不含数据集本体）。 */
export interface SourceState {
  index: number;
  url: string;
  total: number;
  loadedAt: number | null;
  /** 本次是否未回源该来源（命中 KV 或复用缓存）。 */
  cached: boolean;
}

/** 某个来源的失败信息。 */
export interface SourceFailure {
  index: number;
  url: string;
  error: string;
}

/** 聚合后的加载结果。 */
export interface LoadResult {
  /** 所有可用来源合并成的统一数据集。 */
  dataset: QuoteDataset;
  /** 本次是否完全未回源上游（所有来源都命中缓存）。 */
  cached: boolean;
  /** 各来源中最近一次成功加载的时间。 */
  loadedAt: number | null;
  /** 参与合并的来源。 */
  sources: SourceState[];
  /** 加载失败、未参与合并的来源。 */
  failures: SourceFailure[];
}

/** 单个来源的 KV 快照。 */
interface SourceSnapshot {
  dataset: QuoteDataset;
  /** 写入 KV 的原始 JSON 文本；304 续期时原样回写，避免重新序列化。 */
  raw: string;
  loadedAt: number | null;
  etag: string | null;
}

/** 内部使用的来源状态：在 SourceState 之上携带数据集本体。 */
interface LoadedSource extends SourceState {
  dataset: QuoteDataset;
}

/** 单个来源的加载结果：成功或失败二选一。 */
interface SourceOutcome {
  state: LoadedSource | null;
  failure: SourceFailure | null;
}

/** 进程内热缓存条目。 */
interface MemoryEntry {
  result: LoadResult;
  expiresAt: number;
  /** 来源列表指纹；来源配置变化后立即失效。 */
  sourcesKey: string;
}

let memory: MemoryEntry | null = null;

/**
 * 清空进程内热缓存。
 *
 * 热缓存以 isolate 为单位，无法跨 isolate 全局失效，因此它只用于
 * 「避免每个请求都重复读 KV 并全量解析数据集」，不承担一致性保证。
 */
export function invalidateMemoryCache(): void {
  memory = null;
}

/** 读取命中的热缓存：来源列表不一致或已过期都视为未命中。 */
function readMemory(sourcesKey: string): LoadResult | null {
  if (memory === null || memory.sourcesKey !== sourcesKey || memory.expiresAt <= Date.now()) {
    return null;
  }
  return memory.result;
}

/** 写入热缓存并返回原结果，便于链式返回。 */
function writeMemory(result: LoadResult, sourcesKey: string): LoadResult {
  memory = { result, expiresAt: Date.now() + MEMORY_CACHE_TTL_MS, sourcesKey };
  return result;
}

/** 取多个时间戳中的最大值；全为 null 时返回 null。 */
function maxLoadedAt(values: readonly (number | null)[]): number | null {
  let max: number | null = null;
  for (const value of values) {
    if (value === null) continue;
    max = max === null ? value : Math.max(max, value);
  }
  return max;
}

/** 取最新的 `updated_at`（ISO 时间戳可直接按字典序比较）；全为空时返回空串。 */
function latestUpdatedAt(values: readonly string[]): string {
  const sorted = values.filter((value) => value.length > 0).sort();
  return sorted.length > 0 ? sorted[sorted.length - 1] : '';
}

/** 读取可选字符串字段：缺省合法；类型错误直接抛错（避免下游出现隐式 TypeError）。 */
function readOptionalString(
  record: Record<string, unknown>,
  key: string,
  index: number,
  label: string
): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new UpstreamError(`${label}格式非法：第 ${index} 条记录的 ${key} 必须是字符串。`);
  }
  return value;
}

/** 读取可选 tags 字段：必须是字符串数组，否则抛错。 */
function readOptionalTags(
  record: Record<string, unknown>,
  index: number,
  label: string
): string[] | undefined {
  const value = record.tags;
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || !value.every((tag) => typeof tag === 'string')) {
    throw new UpstreamError(`${label}格式非法：第 ${index} 条记录的 tags 必须是字符串数组。`);
  }
  return value as string[];
}

/**
 * 校验单个来源的数据集结构。非法数据直接抛错（由上层决定是回源失败还是缓存损坏）。
 *
 * 这里做的是「校验 + 归一」：只保留已知字段，缺失的可选字段置为 undefined，
 * 因此返回值可以安全地当作 `Quote` 使用，无需下游再做类型兜底。
 *
 * @param label 出错信息前缀，用于区分是哪个来源 / 是缓存还是上游。
 */
export function validateDataset(input: unknown, label = '数据集'): QuoteDataset {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new UpstreamError(`${label}格式非法：根节点必须是对象。`);
  }

  const root = input as Record<string, unknown>;

  if (typeof root.version !== 'number' || !Number.isFinite(root.version)) {
    throw new UpstreamError(`${label}格式非法：version 必须是数字。`);
  }
  if (!Array.isArray(root.quotes)) {
    throw new UpstreamError(`${label}格式非法：quotes 必须是数组。`);
  }

  const quotes: Quote[] = root.quotes.map((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new UpstreamError(`${label}格式非法：第 ${index} 条记录不是对象。`);
    }
    const record = item as Record<string, unknown>;

    const id = record.id;
    if (typeof id !== 'string' || id.length === 0) {
      throw new UpstreamError(`${label}格式非法：第 ${index} 条记录缺少 id。`);
    }
    const content = record.content;
    if (typeof content !== 'string' || content.length === 0) {
      throw new UpstreamError(`${label}格式非法：第 ${index} 条记录缺少 content。`);
    }

    return {
      id,
      content,
      source: readOptionalString(record, 'source', index, label),
      author: readOptionalString(record, 'author', index, label),
      category: readOptionalString(record, 'category', index, label),
      tags: readOptionalTags(record, index, label),
    };
  });

  return {
    version: root.version,
    updated_at: typeof root.updated_at === 'string' ? root.updated_at : '',
    quotes,
  };
}

/** 把上游原始文本解析为数据集：JSON 解析失败与结构非法都归一为 UpstreamError。 */
export function parseDataset(raw: string, label = '数据集'): QuoteDataset {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new UpstreamError(`${label}不是合法 JSON：${reason}`);
  }
  return validateDataset(parsed, label);
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

/** 读取某个来源的 KV 快照：不存在返回 null；损坏则连同元信息清理并返回 null（触发回源）。 */
async function readSnapshot(env: Env, index: number): Promise<SourceSnapshot | null> {
  // 数据集与元信息并发读取，避免两次串行的 KV 往返。
  const [raw, metaRaw] = await Promise.all([
    env.CACHE.get(dataKey(index)),
    env.CACHE.get(metaKey(index)),
  ]);
  if (raw === null) return null;

  try {
    const { loadedAt, etag } = parseMeta(metaRaw);
    return { dataset: validateDataset(JSON.parse(raw), '缓存'), raw, loadedAt, etag };
  } catch (err) {
    console.error(`[epigram] KV 缓存损坏（来源 #${index}），已删除并回源：`, err);
    await Promise.all([env.CACHE.delete(dataKey(index)), env.CACHE.delete(metaKey(index))]);
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
      throw new UpstreamError(`数据源 ${url} 返回 ${res.status}。`);
    }
    return { status: res.status, text: await res.text(), etag: res.headers.get('ETag') };
  } catch (err) {
    if (err instanceof UpstreamError) throw err;
    const reason = err instanceof Error ? err.message : String(err);
    throw new UpstreamError(`数据源 ${url} 请求失败：${reason}`);
  } finally {
    clearTimeout(timer);
  }
}

/** 回写某个来源的数据集与元信息（同时重置 TTL）。 */
async function writeCache(
  env: Env,
  index: number,
  url: string,
  raw: string,
  loadedAt: number,
  etag: string | null
): Promise<void> {
  const ttl = resolveDataTtl(env);
  const meta: DatasetMeta = { loaded_at: loadedAt, source_url: url };
  if (etag !== null) meta.etag = etag;

  await Promise.all([
    env.CACHE.put(dataKey(index), raw, { expirationTtl: ttl }),
    env.CACHE.put(metaKey(index), JSON.stringify(meta), { expirationTtl: ttl }),
  ]);
}

/**
 * 加载单个来源。
 *
 * @param force 为 true 时即使命中 KV 也要走一次条件请求（管理端强制刷新用）。
 */
async function loadSource(
  env: Env,
  index: number,
  url: string,
  force: boolean
): Promise<LoadedSource> {
  const snapshot = await readSnapshot(env, index);

  if (!force && snapshot !== null) {
    return {
      index,
      url,
      dataset: snapshot.dataset,
      total: snapshot.dataset.quotes.length,
      loadedAt: snapshot.loadedAt,
      cached: true,
    };
  }

  const upstream = await fetchUpstream(url, snapshot?.etag ?? null);

  if (upstream.status === 304) {
    if (snapshot === null) {
      // 没有本地数据时不会携带 If-None-Match，理论上不可达；显式兜底避免死循环。
      throw new UpstreamError(`数据源 ${url} 返回 304，但本地没有可用缓存。`);
    }
    // 上游未变更：复用缓存数据，仅重置 KV 过期时间。
    const loadedAt = snapshot.loadedAt ?? Date.now();
    await writeCache(env, index, url, snapshot.raw, loadedAt, snapshot.etag);
    return {
      index,
      url,
      dataset: snapshot.dataset,
      total: snapshot.dataset.quotes.length,
      loadedAt,
      cached: true,
    };
  }

  const raw = upstream.text ?? '';
  const dataset = parseDataset(raw, `数据源 ${url} `);
  const loadedAt = Date.now();
  await writeCache(env, index, url, raw, loadedAt, upstream.etag);
  return {
    index,
    url,
    dataset,
    total: dataset.quotes.length,
    loadedAt,
    cached: false,
  };
}

/**
 * 并发加载全部来源，并合并成一个统一池。
 *
 * 容错策略：单个来源失败不拖垮整体——该来源被跳过并记入 `failures`（同时打日志），
 * 其余来源照常合并；只有**全部来源都失败**才抛错（由顶层转成 500）。
 * 这样个别上游抖动时 API 仍然可用，只少了一部分内容。
 */
async function loadAllSources(env: Env, urls: string[], force: boolean): Promise<LoadResult> {
  const outcomes = await Promise.all(
    urls.map(async (url, index): Promise<SourceOutcome> => {
      try {
        return { state: await loadSource(env, index, url, force), failure: null };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.error(`[epigram] 数据源加载失败（#${index} ${url}）：${reason}`);
        return { state: null, failure: { index, url, error: reason } };
      }
    })
  );

  const loaded: LoadedSource[] = [];
  const failures: SourceFailure[] = [];
  for (const outcome of outcomes) {
    if (outcome.state !== null) loaded.push(outcome.state);
    else if (outcome.failure !== null) failures.push(outcome.failure);
  }

  if (loaded.length === 0) {
    // 单来源时直接抛出原始错误，避免套一层「全部失败」前缀造成信息冗余。
    if (urls.length === 1 && failures.length === 1) {
      throw new UpstreamError(failures[0].error);
    }
    const detail = failures.map((item) => `#${item.index} ${item.url}：${item.error}`).join('；');
    throw new UpstreamError(`全部 ${urls.length} 个数据源均加载失败。${detail}`);
  }

  // 合并：条目拼接成总池，version / updated_at 取各来源的「最大值」作为聚合标识。
  const dataset: QuoteDataset = {
    version: Math.max(...loaded.map((item) => item.dataset.version)),
    updated_at: latestUpdatedAt(loaded.map((item) => item.dataset.updated_at)),
    quotes: loaded.flatMap((item) => item.dataset.quotes),
  };

  return {
    dataset,
    cached: loaded.every((item) => item.cached),
    loadedAt: maxLoadedAt(loaded.map((item) => item.loadedAt)),
    sources: loaded.map(({ index, url, total, loadedAt, cached }) => ({
      index,
      url,
      total,
      loadedAt,
      cached,
    })),
    failures,
  };
}

/**
 * 强制刷新全部来源（管理端 `/refresh` 使用）。
 * 单个来源校验失败或拉取失败都不会污染它已有的缓存；全部失败时抛错。
 */
export async function refreshAllSources(env: Env): Promise<LoadResult> {
  const urls = resolveDataSources(env);
  return writeMemory(await loadAllSources(env, urls, true), urls.join('\n'));
}

/**
 * 策略 A（懒加载）：热缓存 → 各来源 KV → 回源，逐级兜底。
 *
 * `cached` 为 true 表示本次完全没有回源上游；只要有来源走了上游即为 false。
 */
export async function loadDatasetWithMeta(env: Env): Promise<LoadResult> {
  const urls = resolveDataSources(env);
  const sourcesKey = urls.join('\n');

  const hot = readMemory(sourcesKey);
  if (hot !== null) return { ...hot, cached: true };

  return writeMemory(await loadAllSources(env, urls, false), sourcesKey);
}

/** 只需要合并后数据集时的便捷封装。 */
export async function loadDataset(env: Env): Promise<QuoteDataset> {
  const { dataset } = await loadDatasetWithMeta(env);
  return dataset;
}

/** 只读缓存状态（不触发回源），供健康检查使用；优先命中热缓存以避免重复解析。 */
export async function peekCache(env: Env): Promise<{
  cached: boolean;
  loadedAt: number | null;
  total: number;
  sourcesLoaded: number;
  sourcesTotal: number;
}> {
  const urls = resolveDataSources(env);

  const hot = readMemory(urls.join('\n'));
  if (hot !== null) {
    return {
      cached: true,
      loadedAt: hot.loadedAt,
      total: hot.dataset.quotes.length,
      sourcesLoaded: hot.sources.length,
      sourcesTotal: urls.length,
    };
  }

  // 热缓存未命中时逐个来源只读 KV（并发），不触发任何回源。
  const snapshots = await Promise.all(urls.map((_, index) => readSnapshot(env, index)));
  const available = snapshots.filter((item): item is SourceSnapshot => item !== null);

  return {
    cached: available.length > 0,
    loadedAt: maxLoadedAt(available.map((item) => item.loadedAt)),
    total: available.reduce((sum, item) => sum + item.dataset.quotes.length, 0),
    sourcesLoaded: available.length,
    sourcesTotal: urls.length,
  };
}
