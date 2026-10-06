import { describe, expect, it } from 'vitest';
import { validateDataset } from '../src/data/loader';
import type { QuoteDataset } from '../src/data/types';

// 仓库内的示例数据集不会被运行时读取（只是可推送到 quotify-data 的模板），
// 但它以前完全没有校验：手工编辑出错只能等到线上才发现。这里把它纳入 CI。
import dataset from '../data/data.json';

const parsed = validateDataset(dataset, 'data/data.json');

describe('data/data.json（示例数据仓库）', () => {
  it('能通过运行时同一套校验（格式与线上要求完全一致）', () => {
    expect(() => validateDataset(dataset, 'data/data.json')).not.toThrow();
  });

  it('version 与 updated_at 齐全', () => {
    expect(typeof parsed.version).toBe('number');
    expect(parsed.updated_at.length).toBeGreaterThan(0);
  });

  it('id 在文件内唯一（否则多来源合并会被去重丢弃）', () => {
    const ids = parsed.quotes.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('每条都有非空 content，且无重复正文', () => {
    for (const quote of parsed.quotes) {
      expect(quote.content.length).toBeGreaterThan(0);
    }
    const contents = parsed.quotes.map((item) => item.content);
    expect(new Set(contents).size).toBe(contents.length);
  });

  it('updated_at 是合法的时间戳', () => {
    expect(Number.isNaN(Date.parse(parsed.updated_at))).toBe(false);
  });

  it('每条都至少有一个分类，避免出现无法过滤的孤儿条目', () => {
    for (const quote of parsed.quotes) {
      expect(quote.category).toBeTruthy();
    }
  });

  it('聚合字段可直接构造 QuoteDataset', () => {
    const typed: QuoteDataset = parsed;
    expect(typed.quotes.length).toBe(parsed.quotes.length);
  });
});
