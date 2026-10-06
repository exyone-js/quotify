import {
  FETCH_TIMEOUT_MS,
  GITHUB_CACHE_TTL,
  MEMORY_CACHE_TTL_MS,
  dataKey,
  limitSources,
  manifestKey,
  metaKey,
  parseSourceList,
  resolveBaselineSources,
  resolveDataTtl,
  resolveManifestUrl,
} from '../config';
import type { Env } from '../types/env';
import { UpstreamError } from '../utils/error';
import type { DatasetMeta, Quote, QuoteDataset } from './types';

/** 某个来源的加载状态（对外可序列化，不含数据集本体）。 */
export interface SourceState {
  url: string;
  total: number;
  loadedAt: number | null;
  /** 本次是否未回源该来源（命中 KV 或复用缓存）。 */
  cached: boolean;
}

/** 某个来源的失败信息。 */
export interface SourceFailure {
  url: string;
  error: string;
}

/** 来源清单的加载状态（未配置清单时为 null）。 */
export interface ManifestState {
  url: string;
  /** 清单里解析出的来源个数。 */
  count: number;
  /** 清单加载 / 解析出错时的原因；正常时为 null。 */
  error: string | null;
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
  /** 来源清单状态；未配置 `DATA_MANIFEST_URL` 时为 null。 */
  manifest: ManifestState | null;
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
  /** 配置指纹（基线来源 + 清单地址）；配置变化后立即失效。 */
  configKey: string;
}

/** 清单文件的 KV 记录：自包含原文 + 加载时间 + ETag。 */
interface ManifestRecord {
  raw: string;
  loadedAt: number;
  etag: string | null;
}

/** 清单加载结果：解析出的来源 + 对外披露的状态。 */
interface ManifestResult {
  urls: string[];
  state: ManifestState;
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

/** 读取命中的热缓存：配置指纹不一致或已过期都视为未命中。 */
function readMemory(configKey: string): LoadResult | null {
  if (memory === null || memory.configKey !== configKey || memory.expiresAt <= Date.now()) {
    return null;
  }
  return memory.result;
}

/** 写入热缓存并返回原结果，便于链式返回。 */
function writeMemory(result: LoadResult, configKey: string): LoadResult {
  memory = { result, expiresAt: Date.now() + MEMORY_CACHE_TTL_MS, configKey };
  return result;
}

/** 由「基线来源 + 清单地址」构成的配置指纹，用于热缓存失效判断。 */
function configKeyOf(baseline: readonly string[], manifestUrl: string | null): string {
  return `${baseline.join('\n')}|${manifestUrl ?? ''}`;
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

/** 缓存元信息中我们关心的字段。 */
interface ParsedMeta {
  loadedAt: number | null;
  etag: string | null;
  sourceUrl: string | null;
}

/** 解析缓存元信息；缺失或损坏时返回空值（只影响展示与条件请求，不影响数据本身）。 */
function parseMeta(metaRaw: string | null): ParsedMeta {
  if (metaRaw === null) return { loadedAt: null, etag: null, sourceUrl: null };
  try {
    const { loaded_at: loadedAt, etag, source_url: sourceUrl } = JSON.parse(metaRaw) as Partial<DatasetMeta>;
    return {
      loadedAt: typeof loadedAt === 'number' ? loadedAt : null,
      etag: typeof etag === 'string' && etag.length > 0 ? etag : null,
      sourceUrl: typeof sourceUrl === 'string' && sourceUrl.length > 0 ? sourceUrl : null,
    };
  } catch {
    return { loadedAt: null, etag: null, sourceUrl: null };
  }
}

/**
 * 读取某个来源的 KV 快照：不存在返回 null；损坏则连同元信息清理并返回 null（触发回源）。
 *
 * 读取时会比对 meta 里的 `source_url`：键虽由 URL 派生，但哈希碰撞或人工写错键
 * 都可能让「别的来源的数据」落在同一个键上，比对不一致就当作未命中，杜绝串数据。
 */
async function readSnapshot(env: Env, url: string): Promise<SourceSnapshot | null> {
  // 数据集与元信息并发读取，避免两次串行的 KV 往返。
  const [raw, metaRaw] = await Promise.all([
    env.CACHE.get(dataKey(url)),
    env.CACHE.get(metaKey(url)),
  ]);
  if (raw === null) return null;

  try {
    const meta = parseMeta(metaRaw);
    if (meta.sourceUrl !== null && meta.sourceUrl !== url) {
      console.warn(
        `[quotify] 缓存来源不匹配（期望 ${url}，实际 ${meta.sourceUrl}），忽略该缓存并回源。`
      );
      return null;
    }
    return {
      dataset: validateDataset(JSON.parse(raw), '缓存'),
      raw,
      loadedAt: meta.loadedAt,
      etag: meta.etag,
    };
  } catch (err) {
    console.error(`[quotify] KV 缓存损坏（${url}），已删除并回源：`, err);
    await Promise.all([env.CACHE.delete(dataKey(url)), env.CACHE.delete(metaKey(url))]);
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
      'User-Agent': 'quotify-worker',
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
      throw new UpstreamError(`远程 ${url} 返回 ${res.status}。`);
    }
    return { status: res.status, text: await res.text(), etag: res.headers.get('ETag') };
  } catch (err) {
    if (err instanceof UpstreamError) throw err;
    const reason = err instanceof Error ? err.message : String(err);
    throw new UpstreamError(`远程 ${url} 请求失败：${reason}`);
  } finally {
    clearTimeout(timer);
  }
}

/** 回写某个来源的数据集与元信息（同时重置 TTL）。 */
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
    env.CACHE.put(dataKey(url), raw, { expirationTtl: ttl }),
    env.CACHE.put(metaKey(url), JSON.stringify(meta), { expirationTtl: ttl }),
  ]);
}

/**
 * 加载单个来源。
 *
 * @param force 为 true 时即使命中 KV 也要走一次条件请求（管理端强制刷新用）。
 */
async function loadSource(env: Env, url: string, force: boolean): Promise<LoadedSource> {
  const snapshot = await readSnapshot(env, url);

  if (!force && snapshot !== null) {
    return {
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
      throw new UpstreamError(`${url} 返回 304，但本地没有可用缓存。`);
    }
    // 上游未变更：复用缓存数据，仅重置 KV 过期时间。
    const loadedAt = snapshot.loadedAt ?? Date.now();
    await writeCache(env, url, snapshot.raw, loadedAt, snapshot.etag);
    return {
      url,
      dataset: snapshot.dataset,
      total: snapshot.dataset.quotes.length,
      loadedAt,
      cached: true,
    };
  }

  const raw = upstream.text ?? '';
  const dataset = parseDataset(raw, `来源 ${url} `);
  const loadedAt = Date.now();
  await writeCache(env, url, raw, loadedAt, upstream.etag);
  return { url, dataset, total: dataset.quotes.length, loadedAt, cached: false };
}

// ---------------------------------------------------------------------------
// 来源清单（可选）：把「来源列表」从部署期配置变成运行期数据
// ---------------------------------------------------------------------------

/** 读取清单的 KV 记录；不存在返回 null，损坏则删除并返回 null。 */
async function readManifestRecord(env: Env, key: string): Promise<ManifestRecord | null> {
  const raw = await env.CACHE.get(key);
  if (raw === null) return null;

  try {
    const record = JSON.parse(raw) as Partial<ManifestRecord>;
    if (typeof record.raw !== 'string') {
      throw new Error('清单缓存缺少 raw 字段。');
    }
    return {
      raw: record.raw,
      loadedAt: typeof record.loadedAt === 'number' ? record.loadedAt : 0,
      etag: typeof record.etag === 'string' && record.etag.length > 0 ? record.etag : null,
    };
  } catch (err) {
    console.error('[quotify] 清单缓存损坏，已删除：', err);
    await env.CACHE.delete(key);
    return null;
  }
}

/** 回写清单缓存（TTL 与数据集一致）。 */
async function writeManifestRecord(
  env: Env,
  key: string,
  raw: string,
  loadedAt: number,
  etag: string | null
): Promise<void> {
  const record: ManifestRecord = { raw, loadedAt, etag };
  await env.CACHE.put(key, JSON.stringify(record), { expirationTtl: resolveDataTtl(env) });
}

/**
 * 把清单原文解析为来源列表。
 *
 * 清单属于「运行期数据」（可能被协作者随手改动），格式非法时**降级**为
 * 「沿用上一份合法清单 / 不加额外来源」，而不是让整个服务不可用；
 * 失败原因会记录到日志与 `manifest.error`，不会静默。
 */
function parseManifestUrls(raw: string, url: string): string[] | null {
  try {
    return parseSourceList(raw, `清单文件 ${url}`);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[quotify] 清单文件格式非法（${url}）：${reason}`);
    return null;
  }
}

/**
 * 加载「来源清单」：一个 JSON 字符串数组，元素为数据集 URL（与 `DATA_SOURCES` 同格式）。
 *
 * @param force      为 true 时强制走条件请求刷新（管理端 `/refresh` 用）
 * @param allowFetch 为 false 时只读 KV、绝不回源（健康检查用）
 */
async function loadManifest(
  env: Env,
  force: boolean,
  allowFetch = true
): Promise<ManifestResult | null> {
  const url = resolveManifestUrl(env);
  if (url === null) return null;

  const key = manifestKey(url);
  const record = await readManifestRecord(env, key);
  /** 用缓存里的清单内容兜底：没有缓存就是「不加额外来源」。 */
  const cachedUrls = (): string[] =>
    record === null ? [] : (parseManifestUrls(record.raw, url) ?? []);
  const done = (urls: string[], error: string | null): ManifestResult => ({
    urls,
    state: { url, count: urls.length, error },
  });

  if (!force && record !== null) {
    return done(cachedUrls(), null);
  }
  if (!allowFetch) {
    return done(cachedUrls(), null);
  }

  try {
    const upstream = await fetchUpstream(url, record?.etag ?? null);

    if (upstream.status === 304 && record !== null) {
      await writeManifestRecord(
        env,
        key,
        record.raw,
        record.loadedAt > 0 ? record.loadedAt : Date.now(),
        record.etag
      );
      return done(cachedUrls(), null);
    }

    const raw = upstream.text ?? '';
    const parsed = parseManifestUrls(raw, url);
    if (parsed === null) {
      // 内容非法：保留上一份合法清单，不回写 KV。
      return done(cachedUrls(), '清单文件格式非法，已沿用上一份缓存');
    }
    await writeManifestRecord(env, key, raw, Date.now(), upstream.etag);
    return done(parsed, null);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[quotify] 清单文件加载失败（${url}）：${reason}`);
    return done(cachedUrls(), reason);
  }
}

/**
 * 加载全部来源（基线 + 可选清单）并合并成一个统一池。
 *
 * 容错策略：单个来源失败不拖垮整体——该来源被跳过并记入 `failures`（同时打日志），
 * 其余来源照常合并；只有**全部来源都失败**才抛错（由顶层转成 500）。
 * 这样个别上游抖动时 API 仍然可用，只少了一部分内容。
 */
async function loadAggregate(env: Env, baseline: string[], force: boolean): Promise<LoadResult> {
  const manifest = await loadManifest(env, force);
  const urls = limitSources([...baseline, ...(manifest?.urls ?? [])]);

  if (urls.length === 0) {
    throw new UpstreamError('未解析到任何数据来源：请检查 DATA_SOURCES 与 DATA_MANIFEST_URL 配置。');
  }

  const outcomes = await Promise.all(
    urls.map(async (url): Promise<SourceOutcome> => {
      try {
        return { state: await loadSource(env, url, force), failure: null };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.error(`[quotify] 数据来源加载失败（${url}）：${reason}`);
        return { state: null, failure: { url, error: reason } };
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
    const detail = failures.map((item) => `${item.url}：${item.error}`).join('；');
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
    sources: loaded.map(({ url, total, loadedAt, cached }) => ({ url, total, loadedAt, cached })),
    failures,
    manifest: manifest?.state ?? null,
  };
}

/**
 * 强制刷新全部来源与清单（管理端 `/refresh` 使用）。
 * 单个来源校验失败或拉取失败都不会污染它已有的缓存；全部来源失败时抛错。
 */
export async function refreshAllSources(env: Env): Promise<LoadResult> {
  const baseline = resolveBaselineSources(env);
  const configKey = configKeyOf(baseline, resolveManifestUrl(env));
  return writeMemory(await loadAggregate(env, baseline, true), configKey);
}

/**
 * 策略 A（懒加载）：热缓存 → 各来源 KV → 回源，逐级兜底。
 *
 * `cached` 为 true 表示本次完全没有回源上游；只要有来源走了上游即为 false。
 */
export async function loadDatasetWithMeta(env: Env): Promise<LoadResult> {
  const baseline = resolveBaselineSources(env);
  const configKey = configKeyOf(baseline, resolveManifestUrl(env));

  const hot = readMemory(configKey);
  if (hot !== null) return { ...hot, cached: true };

  return writeMemory(await loadAggregate(env, baseline, false), configKey);
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
  const baseline = resolveBaselineSources(env);

  const hot = readMemory(configKeyOf(baseline, resolveManifestUrl(env)));
  if (hot !== null) {
    return {
      cached: true,
      loadedAt: hot.loadedAt,
      total: hot.dataset.quotes.length,
      sourcesLoaded: hot.sources.length,
      sourcesTotal: hot.sources.length + hot.failures.length,
    };
  }

  // 冷路径：清单与各来源都只读 KV（并发），不触发任何回源。
  const manifest = await loadManifest(env, false, false);
  const urls = limitSources([...baseline, ...(manifest?.urls ?? [])]);
  const snapshots = await Promise.all(urls.map((url) => readSnapshot(env, url)));
  const available = snapshots.filter((item): item is SourceSnapshot => item !== null);

  return {
    cached: available.length > 0,
    loadedAt: maxLoadedAt(available.map((item) => item.loadedAt)),
    total: available.reduce((sum, item) => sum + item.dataset.quotes.length, 0),
    sourcesLoaded: available.length,
    sourcesTotal: urls.length,
  };
}
