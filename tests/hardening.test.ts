import { env, SELF } from 'cloudflare:test';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FETCH_RETRY_BASE_DELAY_MS,
  FETCH_TIMEOUT_MS,
  dataKey,
  manifestKey,
  metaKey,
  resolveManifestUrl,
} from '../src/config';
import { invalidateMemoryCache, loadDatasetWithMeta } from '../src/data/loader';
import { adminAuth, safeEqual } from '../src/middleware/auth';
import { publicRateLimit } from '../src/middleware/rateLimit';
import type { Env } from '../src/types/env';
import { parseLimit, parseOffset, parseText, toErrorResponse } from '../src/utils/error';
import { etagMatches, fail } from '../src/utils/response';

const DEFAULT_MANIFEST = resolveManifestUrl(env as unknown as Env) as string;
const SOURCE_URL =
  'https://raw.githubusercontent.com/exyone-js/quotify-data/main/data/literature.json';
const SOURCE_A = 'https://example.test/a.json';
const SOURCE_B = 'https://example.test/b.json';
const CUSTOM_MANIFEST_URL = 'https://example.test/sources.json';
const BASE = 'https://quotify.test';

const DATASET = {
  version: 1,
  updated_at: '2026-09-26T12:00:00Z',
  quotes: [
    { id: 'a1', content: '第一条。', category: '文学' },
    { id: 'a2', content: '第二条。', category: '哲学' },
  ],
};

function urlOf(input: unknown): string {
  return input instanceof Request ? input.url : String(input);
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * 用真实的 KV binding + 指定的来源 / 清单配置拼一个最小 env。
 * 注意：`DATA_MANIFEST_URL` 传空串表示**关闭清单**，所以只给 baseline 时
 * 必须显式列出来源，否则会拿到「未解析到任何数据来源」。
 */
function sourceEnv(urls: string[], manifestUrl = ''): Env {
  return {
    CACHE: env.CACHE,
    DATA_SOURCES: JSON.stringify(urls),
    DATA_MANIFEST_URL: manifestUrl,
  } as unknown as Env;
}

beforeEach(async () => {
  invalidateMemoryCache();
  await Promise.all(
    [
      dataKey(SOURCE_URL),
      metaKey(SOURCE_URL),
      dataKey(SOURCE_A),
      metaKey(SOURCE_A),
      dataKey(SOURCE_B),
      metaKey(SOURCE_B),
      manifestKey(DEFAULT_MANIFEST),
      manifestKey(CUSTOM_MANIFEST_URL),
    ].map((key) => env.CACHE.delete(key)),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('P0-1 随机接口禁止被缓存', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', async (input: unknown) => {
      const url = urlOf(input);
      if (url === DEFAULT_MANIFEST) return jsonResponse([SOURCE_URL]);
      if (url === SOURCE_URL) return jsonResponse(DATASET);
      throw new Error(`unexpected fetch: ${url}`);
    });
  });

  it('/api/quotes 带 Cache-Control: no-store', async () => {
    const res = await SELF.fetch(`${BASE}/api/quotes`);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('/api/quotes?format=text 带 Cache-Control: no-store', async () => {
    const res = await SELF.fetch(`${BASE}/api/quotes?format=text`);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('/api/quotes/search 与 /api/health 同样不被缓存', async () => {
    const search = await SELF.fetch(`${BASE}/api/quotes/search?q=${encodeURIComponent('第一')}`);
    expect(search.headers.get('Cache-Control')).toBe('no-store');

    const health = await SELF.fetch(`${BASE}/api/health`);
    expect(health.headers.get('Cache-Control')).toBe('no-store');
  });

  it('错误响应也不被缓存', async () => {
    const res = await SELF.fetch(`${BASE}/api/quotes?limit=abc`);
    expect(res.status).toBe(400);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });
});

describe('P0-3 限流只信任 CF-Connecting-IP', () => {
  it('忽略客户端伪造的 x-forwarded-for', async () => {
    const keys: string[] = [];
    const limiter = {
      limit: async (options: { key: string }) => {
        keys.push(options.key);
        return { success: true };
      },
    };

    const app = new Hono<{ Bindings: Env }>();
    app.use('*', publicRateLimit());
    app.get('/', (c) => c.text('ok'));

    await app.request('/', { headers: { 'x-forwarded-for': '1.2.3.4' } }, {
      PUBLIC_RATE_LIMITER: limiter,
    } as unknown as Env);

    // 伪造头不应成为分桶依据，否则轮换该头即可绕过限流。
    expect(keys).toEqual(['public:anonymous']);
  });

  it('有 CF-Connecting-IP 时按它分桶', async () => {
    const keys: string[] = [];
    const limiter = {
      limit: async (options: { key: string }) => {
        keys.push(options.key);
        return { success: true };
      },
    };

    const app = new Hono<{ Bindings: Env }>();
    app.use('*', publicRateLimit());
    app.get('/', (c) => c.text('ok'));

    await app.request(
      '/',
      { headers: { 'CF-Connecting-IP': '9.9.9.9', 'x-forwarded-for': '1.2.3.4' } },
      { PUBLIC_RATE_LIMITER: limiter } as unknown as Env,
    );

    expect(keys).toEqual(['public:9.9.9.9']);
  });
});

describe('P1-1 回源去重与重试', () => {
  it('并发请求共享同一次回源（single-flight）', async () => {
    let sourceCalls = 0;
    vi.stubGlobal('fetch', async (input: unknown) => {
      const url = urlOf(input);
      if (url === DEFAULT_MANIFEST) return jsonResponse([SOURCE_URL]);
      sourceCalls += 1;
      return jsonResponse(DATASET);
    });

    const [first, second] = await Promise.all([
      loadDatasetWithMeta(sourceEnv([SOURCE_URL])),
      loadDatasetWithMeta(sourceEnv([SOURCE_URL])),
    ]);

    // 没有去重时这里会是 2（每个请求各回源一次）。
    expect(sourceCalls).toBe(1);
    expect(first.dataset.quotes).toHaveLength(DATASET.quotes.length);
    expect(second.dataset.quotes).toHaveLength(DATASET.quotes.length);
  });

  it('5xx 会重试，4xx 不重试', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async (input: unknown) => {
      const url = urlOf(input);
      if (url === DEFAULT_MANIFEST) return jsonResponse([SOURCE_URL]);
      calls += 1;
      return new Response('boom', { status: 503 });
    });

    await expect(loadDatasetWithMeta(sourceEnv([SOURCE_URL]))).rejects.toThrow(/503/);
    // 1 次首发 + FETCH_RETRY_COUNT 次重试
    expect(calls).toBe(3);

    calls = 0;
    vi.stubGlobal('fetch', async (input: unknown) => {
      const url = urlOf(input);
      if (url === DEFAULT_MANIFEST) return jsonResponse([SOURCE_URL]);
      calls += 1;
      return new Response('nope', { status: 404 });
    });

    await expect(loadDatasetWithMeta(sourceEnv([SOURCE_URL]))).rejects.toThrow(/404/);
    expect(calls).toBe(1);
  });

  it('上游超时（AbortController 触发）被转成上游错误而不是挂死', async () => {
    vi.useFakeTimers();

    vi.stubGlobal('fetch', async (_input: unknown, init?: RequestInit) => {
      const signal = init?.signal;
      if (signal?.aborted) throw new Error('The operation was aborted');
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('The operation was aborted')));
      });
    });

    const pending = loadDatasetWithMeta(sourceEnv([SOURCE_URL])).then(
      () => null,
      (err: unknown) => err,
    );

    // 推进虚拟时间，让 5 秒超时与重试退避依次触发（不消耗真实时间）。
    for (let i = 0; i < 6; i += 1) {
      await vi.advanceTimersByTimeAsync(FETCH_TIMEOUT_MS + FETCH_RETRY_BASE_DELAY_MS * 4 + 100);
    }

    const err = await pending;
    expect(err).toBeInstanceOf(Error);
    expect(String(err)).toContain('请求失败');
  });
});

describe('P1-2 多来源合并去重', () => {
  it('相同 id 只保留一条，并计入 duplicates', async () => {
    vi.stubGlobal('fetch', async (input: unknown) => {
      const url = urlOf(input);
      if (url === SOURCE_A) return jsonResponse(DATASET);
      // 与 A 有一条同 id，另有一条独有
      return jsonResponse({
        version: 1,
        updated_at: '2026-09-26T12:00:00Z',
        quotes: [
          { id: 'a1', content: '重复的一条。' },
          { id: 'b1', content: '独有的一条。' },
        ],
      });
    });

    const result = await loadDatasetWithMeta(sourceEnv([SOURCE_A, SOURCE_B]));

    expect(result.sources).toHaveLength(2);
    // A(2 条) + B(2 条) - 1 条重复 = 3 条
    expect(result.dataset.quotes).toHaveLength(3);
    expect(result.duplicates).toBe(1);
    expect(new Set(result.dataset.quotes.map((item) => item.id)).size).toBe(3);
  });
});

describe('P1-4 清单来源的 SSRF 防护', () => {
  it('清单里的非 https 来源被忽略，服务仍然可用', async () => {
    vi.stubGlobal('fetch', async (input: unknown) => {
      const url = urlOf(input);
      if (url === CUSTOM_MANIFEST_URL) {
        return jsonResponse(['http://evil.test/a.json', 'file:///etc/passwd', SOURCE_A]);
      }
      return jsonResponse(DATASET);
    });

    const result = await loadDatasetWithMeta(sourceEnv([], CUSTOM_MANIFEST_URL));

    expect(result.manifest?.count).toBe(1);
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]?.url).toBe(SOURCE_A);
  });

  it('配置了 DATA_SOURCE_HOSTS 时，清单里不在白名单的主机被忽略', async () => {
    const OUT_OF_ALLOWLIST = 'https://other.test/c.json';

    vi.stubGlobal('fetch', async (input: unknown) => {
      const url = urlOf(input);
      if (url === CUSTOM_MANIFEST_URL) return jsonResponse([SOURCE_A, OUT_OF_ALLOWLIST]);
      return jsonResponse(DATASET);
    });

    const scoped = {
      CACHE: env.CACHE,
      DATA_MANIFEST_URL: CUSTOM_MANIFEST_URL,
      DATA_SOURCE_HOSTS: 'example.test',
    } as unknown as Env;

    const result = await loadDatasetWithMeta(scoped);

    // 清单里列了 2 个来源，只有命中白名单的 SOURCE_A 被采纳。
    expect(result.manifest?.count).toBe(1);
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]?.url).toBe(SOURCE_A);
  });
});

describe('P0-4 管理接口鉴权', () => {
  it('未配置 ADMIN_TOKEN 时管理接口 500 而不是放行', async () => {
    const app = new Hono<{ Bindings: Env }>();
    app.use('*', adminAuth());
    app.get('/', (c) => c.text('ok'));
    app.onError((err) => {
      const { status, message } = toErrorResponse(err);
      return fail(status, message);
    });

    const res = await app.request('/', {}, {} as Env);
    expect(res.status).toBe(500);
  });

  it('safeEqual 是恒定时间比较且能识别差异', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'ab')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
    expect(safeEqual('', 'a')).toBe(false);
  });
});

describe('参数边界收紧', () => {
  it('parseLimit 拒绝非十进制写法', () => {
    expect(parseLimit('5', 1, 1, 20)).toBe(5);
    expect(() => parseLimit('0x10', 1, 1, 20)).toThrow(/必须是整数/);
    expect(() => parseLimit('1e3', 1, 1, 20)).toThrow(/必须是整数/);
    expect(() => parseLimit('1.5', 1, 1, 20)).toThrow(/必须是整数/);
  });

  it('parseOffset 拒绝负数与超大值', () => {
    expect(parseOffset('0')).toBe(0);
    expect(() => parseOffset('-1')).toThrow();
    expect(() => parseOffset('999999')).toThrow(/不能大于/);
  });

  it('parseText 拒绝超长输入', () => {
    expect(parseText('  ok  ', 'q')).toBe('ok');
    expect(() => parseText('x'.repeat(101), 'q')).toThrow(/长度不能超过/);
  });

  it('分类取值超长时返回 400', async () => {
    vi.stubGlobal('fetch', async (input: unknown) => {
      if (urlOf(input) === DEFAULT_MANIFEST) return jsonResponse([SOURCE_URL]);
      return jsonResponse(DATASET);
    });

    const res = await SELF.fetch(`${BASE}/api/quotes?category=${'x'.repeat(120)}`);
    expect(res.status).toBe(400);
  });
});

describe('ETag 宽松匹配', () => {
  const etag = 'W/"1-2-abcdef"';

  it('容忍 W/ 前缀差异与多值列表', () => {
    expect(etagMatches(etag, etag)).toBe(true);
    expect(etagMatches('"1-2-abcdef"', etag)).toBe(true);
    expect(etagMatches(`W/"other", ${etag}`, etag)).toBe(true);
  });

  it('容忍代理追加的 -gzip 之类后缀', () => {
    expect(etagMatches('"1-2-abcdef-gzip"', etag)).toBe(true);
  });

  it('真正不匹配时返回 false', () => {
    expect(etagMatches(undefined, etag)).toBe(false);
    expect(etagMatches('W/"9-9-ffffff"', etag)).toBe(false);
  });
});
