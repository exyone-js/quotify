import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ROOT_REDIRECT,
  MAX_DATA_SOURCES,
  MAX_DATA_TTL,
  MIN_DATA_TTL,
  isAllowedSourceUrl,
  limitSources,
  parseSourceList,
  resolveBaselineSources,
  resolveDataTtl,
  resolveManifestUrl,
  resolveRootRedirect,
  resolveSourceHosts,
} from '../src/config';
import type { Env } from '../src/types/env';

describe('resolveDataTtl', () => {
  it('未配置 / 非法值回退到默认 300 秒', () => {
    expect(resolveDataTtl({} as Env)).toBe(300);
    expect(resolveDataTtl({ DATA_TTL: 'abc' } as Env)).toBe(300);
    expect(resolveDataTtl({ DATA_TTL: '0' } as Env)).toBe(300);
    expect(resolveDataTtl({ DATA_TTL: '-1' } as Env)).toBe(300);
  });

  it('低于 KV 下限（60 秒）时夹紧，而不是让 CACHE.put 抛错', () => {
    // 这是 P0-5：低于下限会让所有来源写入失败，进而全站 500。
    expect(resolveDataTtl({ DATA_TTL: '30' } as Env)).toBe(MIN_DATA_TTL);
    expect(resolveDataTtl({ DATA_TTL: '1' } as Env)).toBe(MIN_DATA_TTL);
  });

  it('超过上限时夹紧到一年', () => {
    expect(resolveDataTtl({ DATA_TTL: '99999999999' } as Env)).toBe(MAX_DATA_TTL);
  });

  it('区间内的合法值原样保留（向下取整）', () => {
    expect(resolveDataTtl({ DATA_TTL: '600' } as Env)).toBe(600);
    expect(resolveDataTtl({ DATA_TTL: '600.9' } as Env)).toBe(600);
  });
});

describe('resolveRootRedirect', () => {
  it('缺省时返回默认目标', () => {
    expect(resolveRootRedirect({} as Env)).toBe(DEFAULT_ROOT_REDIRECT);
  });

  it('接受站内绝对路径', () => {
    expect(resolveRootRedirect({ ROOT_REDIRECT: '/custom/path' } as Env)).toBe('/custom/path');
    expect(resolveRootRedirect({ ROOT_REDIRECT: '/api/quotes/' } as Env)).toBe('/api/quotes/');
  });

  it('拒绝站外地址与协议相对地址', () => {
    expect(resolveRootRedirect({ ROOT_REDIRECT: 'https://evil.com' } as Env)).toBe(
      DEFAULT_ROOT_REDIRECT,
    );
    expect(resolveRootRedirect({ ROOT_REDIRECT: '//evil.com' } as Env)).toBe(DEFAULT_ROOT_REDIRECT);
    expect(resolveRootRedirect({ ROOT_REDIRECT: 'api/quotes' } as Env)).toBe(DEFAULT_ROOT_REDIRECT);
  });

  it('拒绝反斜杠开头的路径（浏览器会把 \\ 规范化成 /，绕过 // 检查）', () => {
    // P0-6：Location: /\evil.com 会被浏览器当成 //evil.com。
    expect(resolveRootRedirect({ ROOT_REDIRECT: '/\\evil.com' } as Env)).toBe(
      DEFAULT_ROOT_REDIRECT,
    );
    expect(resolveRootRedirect({ ROOT_REDIRECT: '/api/\\evil.com' } as Env)).toBe(
      DEFAULT_ROOT_REDIRECT,
    );
  });

  it('拒绝控制字符、空白与超长目标', () => {
    expect(resolveRootRedirect({ ROOT_REDIRECT: '/a\nb' } as Env)).toBe(DEFAULT_ROOT_REDIRECT);
    expect(resolveRootRedirect({ ROOT_REDIRECT: '/a b' } as Env)).toBe(DEFAULT_ROOT_REDIRECT);
    expect(resolveRootRedirect({ ROOT_REDIRECT: `/a${'b'.repeat(300)}` } as Env)).toBe(
      DEFAULT_ROOT_REDIRECT,
    );
  });

  it('配置前后带空白时先 trim', () => {
    expect(resolveRootRedirect({ ROOT_REDIRECT: '  /custom/path  ' } as Env)).toBe('/custom/path');
  });
});

describe('isAllowedSourceUrl', () => {
  it('只放行 https', () => {
    expect(isAllowedSourceUrl('https://example.com/a.json', [])).toBe(true);
    expect(isAllowedSourceUrl('http://example.com/a.json', [])).toBe(false);
    expect(isAllowedSourceUrl('file:///etc/passwd', [])).toBe(false);
    expect(isAllowedSourceUrl('data:text/plain,x', [])).toBe(false);
  });

  it('非法 URL 返回 false', () => {
    expect(isAllowedSourceUrl('not a url', [])).toBe(false);
  });

  it('配置白名单后只放行白名单主机（大小写不敏感）', () => {
    const hosts = ['raw.githubusercontent.com'];
    expect(isAllowedSourceUrl('https://raw.githubusercontent.com/a.json', hosts)).toBe(true);
    expect(isAllowedSourceUrl('https://RAW.GitHubUserContent.com/a.json', hosts)).toBe(true);
    expect(isAllowedSourceUrl('https://evil.com/a.json', hosts)).toBe(false);
    // 内网地址同样被拒（防 SSRF）
    expect(isAllowedSourceUrl('https://169.254.169.254/latest/meta-data', hosts)).toBe(false);
  });
});

describe('resolveSourceHosts', () => {
  it('未配置时返回空数组（不限制主机）', () => {
    expect(resolveSourceHosts({} as Env)).toEqual([]);
    expect(resolveSourceHosts({ DATA_SOURCE_HOSTS: '   ' } as Env)).toEqual([]);
  });

  it('按逗号分隔并统一小写', () => {
    expect(resolveSourceHosts({ DATA_SOURCE_HOSTS: ' A.com , b.com ,, c.com ' } as Env)).toEqual([
      'a.com',
      'b.com',
      'c.com',
    ]);
  });
});

describe('resolveBaselineSources', () => {
  it('未配置或显式空数组都不设静态来源', () => {
    expect(resolveBaselineSources({} as Env)).toEqual([]);
    expect(resolveBaselineSources({ DATA_SOURCES: '[]' } as Env)).toEqual([]);
  });

  it('按序解析并去重', () => {
    expect(resolveBaselineSources({ DATA_SOURCES: '["a", "b", "a"]' } as Env)).toEqual(['a', 'b']);
  });

  it('非法 JSON 时降级为空列表（而不是让整个 API 不可用）', () => {
    // P1-7：来源还可能全部来自清单，一个配置笔误不该让服务 500。
    expect(resolveBaselineSources({ DATA_SOURCES: 'not-json' } as Env)).toEqual([]);
    expect(resolveBaselineSources({ DATA_SOURCES: '{"a":1}' } as Env)).toEqual([]);
  });
});

describe('parseSourceList', () => {
  it('去空、去空白、去重', () => {
    expect(parseSourceList('["a", " a ", "", "b", "a"]', 'X')).toEqual(['a', 'b']);
  });

  it('结构非法时抛错；元素非字符串时静默丢弃', () => {
    expect(() => parseSourceList('{"a":1}', 'X')).toThrow(/必须是 JSON 字符串数组/);
    expect(() => parseSourceList('not-json', 'X')).toThrow(/不是合法 JSON/);
    // 元素里的非字符串被过滤掉，而不是整份清单报错（避免一条脏数据拖垮全部来源）
    expect(parseSourceList('[1, "b", null]', 'X')).toEqual(['b']);
  });
});

describe('limitSources', () => {
  it('未超上限时原样返回（去重后）', () => {
    expect(limitSources(['a', 'b', 'a'])).toEqual(['a', 'b']);
  });

  it('超过 MAX_DATA_SOURCES 时截断到上限', () => {
    const many = Array.from({ length: MAX_DATA_SOURCES + 5 }, (_, i) => `s${i}`);
    const limited = limitSources(many);
    expect(limited).toHaveLength(MAX_DATA_SOURCES);
    // 保留靠前的来源：顺序即优先级
    expect(limited[0]).toBe('s0');
  });
});

describe('resolveManifestUrl', () => {
  it('显式留空时关闭清单', () => {
    expect(resolveManifestUrl({ DATA_MANIFEST_URL: '' } as Env)).toBeNull();
    expect(resolveManifestUrl({ DATA_MANIFEST_URL: '   ' } as Env)).toBeNull();
  });

  it('自定义地址时优先使用并去掉首尾空白', () => {
    expect(resolveManifestUrl({ DATA_MANIFEST_URL: ' https://x/y.json ' } as Env)).toBe(
      'https://x/y.json',
    );
  });
});
