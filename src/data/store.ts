import type { Epigram } from './types';

/** Fisher–Yates 洗牌（返回新数组）。 */
function shuffle(list: Epigram[]): Epigram[] {
  const result = [...list];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/** 随机取 n 条，保证不重复。 */
export function randomPick(list: Epigram[], n: number): Epigram[] {
  if (list.length <= n) return shuffle(list);

  const result: Epigram[] = [];
  const used = new Set<number>();
  while (result.length < n) {
    const i = Math.floor(Math.random() * list.length);
    const item = list[i];
    if (item !== undefined && !used.has(i)) {
      used.add(i);
      result.push(item);
    }
  }
  return result;
}

export interface FilterOptions {
  categories?: string[];
  tags?: string[];
}

/**
 * 过滤：不同维度之间是 AND，同一维度内多个值是 OR。
 */
export function applyFilters(list: Epigram[], opts: FilterOptions): Epigram[] {
  const { categories, tags } = opts;
  return list.filter((e) => {
    if (categories?.length) {
      if (!e.category || !categories.includes(e.category)) return false;
    }
    if (tags?.length) {
      if (!e.tags || !e.tags.some((t) => tags.includes(t))) return false;
    }
    return true;
  });
}

/** 关键词搜索：大小写不敏感，匹配 content / author / source。 */
export function search(list: Epigram[], q: string): Epigram[] {
  const kw = q.trim().toLowerCase();
  if (!kw) return [];
  return list.filter((e) => {
    return (
      e.content.toLowerCase().includes(kw) ||
      (e.author?.toLowerCase().includes(kw) ?? false) ||
      (e.source?.toLowerCase().includes(kw) ?? false)
    );
  });
}

/** 分页。 */
export function paginate(list: Epigram[], limit: number, offset: number): Epigram[] {
  return list.slice(offset, offset + limit);
}

/** 收集去重后的分类（字典序）。 */
export function collectCategories(list: Epigram[]): string[] {
  const set = new Set<string>();
  for (const e of list) {
    if (e.category) set.add(e.category);
  }
  return [...set].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
}

/** 收集去重后的标签（字典序）。 */
export function collectTags(list: Epigram[]): string[] {
  const set = new Set<string>();
  for (const e of list) {
    for (const t of e.tags ?? []) set.add(t);
  }
  return [...set].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
}
