import type { Quote, QuoteDataset } from './types';

/** Fisher–Yates 洗牌（返回新数组）。 */
function shuffle(list: Quote[]): Quote[] {
  const result = [...list];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/**
 * 随机取 n 条，保证不重复。
 *
 * 采用「部分 Fisher–Yates」：只在副本的前 n 个位置做交换，
 * 复杂度稳定为 O(n)，且不会像拒绝采样那样在高填充率下反复重试。
 */
export function randomPick(list: Quote[], n: number): Quote[] {
  if (n >= list.length) return shuffle(list);

  const pool = [...list];
  for (let i = 0; i < n; i += 1) {
    const j = i + Math.floor(Math.random() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, n);
}

export interface FilterOptions {
  categories?: string[];
  tags?: string[];
}

/**
 * 过滤：不同维度之间是 AND，同一维度内多个值是 OR。
 */
export function applyFilters(list: Quote[], opts: FilterOptions): Quote[] {
  const { categories, tags } = opts;
  return list.filter((quote) => {
    if (categories?.length) {
      if (!quote.category || !categories.includes(quote.category)) return false;
    }
    if (tags?.length) {
      if (!quote.tags || !quote.tags.some((tag) => tags.includes(tag))) return false;
    }
    return true;
  });
}

/**
 * 单条引语的小写检索文本（content / author / source 以 U+0000 拼接）。
 *
 * 以记录对象为键做 WeakMap 记忆化：同一份数据集在热缓存存活期内被反复检索时，
 * 无需每个请求都重新 toLowerCase 全量文本。分隔符用 U+0000，
 * 正常关键词不会包含它，因此跨字段误匹配不可能发生。
 */
const lowerTextCache = new WeakMap<Quote, string>();

function lowerText(quote: Quote): string {
  const cached = lowerTextCache.get(quote);
  if (cached !== undefined) return cached;
  const text =
    `${quote.content}\u0000${quote.author ?? ''}\u0000${quote.source ?? ''}`.toLowerCase();
  lowerTextCache.set(quote, text);
  return text;
}

/** 关键词搜索：大小写不敏感，匹配 content / author / source。 */
export function search(list: Quote[], q: string): Quote[] {
  const kw = q.trim().toLowerCase();
  if (!kw) return [];
  return list.filter((quote) => lowerText(quote).includes(kw));
}

/** 分页。 */
export function paginate(list: Quote[], limit: number, offset: number): Quote[] {
  return list.slice(offset, offset + limit);
}

/** 去重、去空并按拼音排序。 */
function collectUnique(values: readonly (string | undefined)[]): string[] {
  const set = new Set<string>();
  for (const value of values) {
    if (value) set.add(value);
  }
  return [...set].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
}

interface EnumerableIndex {
  categories: string[];
  tags: string[];
}

/** 以数据集数组为键记忆化「分类 / 标签」枚举结果，避免每次请求重复全量遍历 + 排序。 */
const enumerableCache = new WeakMap<Quote[], EnumerableIndex>();

function enumerableIndex(list: Quote[]): EnumerableIndex {
  const cached = enumerableCache.get(list);
  if (cached !== undefined) return cached;

  const index: EnumerableIndex = {
    categories: collectUnique(list.map((quote) => quote.category)),
    tags: collectUnique(list.flatMap((quote) => quote.tags ?? [])),
  };
  enumerableCache.set(list, index);
  return index;
}

/** 收集去重后的分类（字典序）。 */
export function collectCategories(list: Quote[]): string[] {
  return enumerableIndex(list).categories;
}

/** 收集去重后的标签（字典序）。 */
export function collectTags(list: Quote[]): string[] {
  return enumerableIndex(list).tags;
}

/**
 * 数据集指纹，用于派生接口的 ETag。
 * 由 version + updated_at + 条数构成：任一变化都会产生新的 ETag，
 * 客户端凭 If-None-Match 命中即可拿到 304，省去重复传输。
 */
export function datasetEtag(dataset: QuoteDataset): string {
  return `W/"${dataset.version}-${dataset.updated_at}-${dataset.quotes.length}"`;
}
