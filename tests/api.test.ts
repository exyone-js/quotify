import { env, SELF } from 'cloudflare:test';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  dataKey,
  manifestKey,
  metaKey,
  resolveBaselineSources,
  resolveManifestUrl,
  resolveRootRedirect,
} from '../src/config';
import {
  invalidateMemoryCache,
  loadDatasetWithMeta,
  refreshAllSources,
} from '../src/data/loader';
import { publicRateLimit } from '../src/middleware/rateLimit';
import type { Env } from '../src/types/env';
import { toErrorResponse } from '../src/utils/error';
import { fail } from '../src/utils/response';

interface Envelope<T> {
  status: number;
  message: string;
  data: T;
  ts: number;
}

interface Quote {
  id: string;
  content: string;
  source?: string;
  author?: string;
  category?: string;
  tags?: string[];
}

/** 固定的 mock 数据集：默认上游桩通过 SOURCE_URL 返回它。 */
const DATASET = {
  version: 1,
  updated_at: '2026-09-26T12:00:00Z',
  quotes: [
    {
      id: 'e1f3a2',
      content: '人生如逆旅，我亦是行人。',
      source: '临江仙·送钱穆父',
      author: '苏轼',
      category: '文学',
      tags: ['古诗', '人生'],
    },
    {
      id: 'b7c9d1',
      content: '落霞与孤鹜齐飞，秋水共长天一色。',
      source: '滕王阁序',
      author: '王勃',
      category: '文学',
      tags: ['古文', '山水'],
    },
    {
      id: 'a2b4c6',
      content: '海内存知己，天涯若比邻。',
      source: '送杜少府之任蜀州',
      author: '王勃',
      category: '文学',
      tags: ['古诗', '友情'],
    },
    {
      id: 'f9e8d7',
      content: '我们都在阴沟里，但仍有人仰望星空。',
      source: '温德米尔夫人的扇子',
      author: '奥斯卡·王尔德',
      category: '文学',
      tags: ['人生', '励志'],
    },
    {
      id: 'c1d2e3',
      content: '认识你自己。',
      source: '德尔斐神庙箴言',
      author: '苏格拉底',
      category: '哲学',
      tags: ['哲学', '人生'],
    },
    {
      id: 'd4e5f6',
      content: '我思故我在。',
      source: '方法论',
      author: '笛卡尔',
      category: '哲学',
      tags: ['哲学', '认识论'],
    },
    {
      id: '0a1b2c',
      content: '凡我不能创造的，我就还没有真正理解。',
      source: '费曼物理学讲义',
      author: '理查德·费曼',
      category: '科技',
      tags: ['物理', '学习方法'],
    },
    {
      id: '3d4e5f',
      content: '过早优化是万恶之源。',
      source: '计算机程序设计艺术',
      author: '唐纳德·克努特',
      category: '科技',
      tags: ['编程', '工程'],
    },
    {
      id: '6a7b8c',
      content: '凡是过往，皆为序章。',
      source: '暴风雨',
      author: '威廉·莎士比亚',
      category: '文学',
      tags: ['戏剧', '人生'],
    },
    {
      id: '9c0d1e',
      content: '知是行之始，行是知之成。',
      source: '传习录',
      author: '王阳明',
      category: '哲学',
      tags: ['哲学', '人生'],
    },
  ],
};

/** 第二个数据集，用于多来源合并用例。 */
const DATASET_B = {
  version: 2,
  updated_at: '2026-09-27T12:00:00Z',
  quotes: [
    {
      id: 'b-0001',
      content: '来自第二个数据源的一条引语。',
      source: '测试集',
      author: '佚名',
      category: '其他',
      tags: ['测试'],
    },
  ],
};

/** 默认来源清单（由 wrangler.toml 的 DATA_MANIFEST_URL 提供，测试环境必定存在）。 */
const DEFAULT_MANIFEST = resolveManifestUrl(env as unknown as Env) as string;
/** 默认清单里列出的数据集地址（测试桩按此地址返回 DATASET）。 */
const SOURCE_URL = 'https://raw.githubusercontent.com/exyone-js/epigram-data/main/data/literature.json';
/** 多来源 / 自定义清单用例使用的地址。 */
const SOURCE_A = 'https://example.test/a.json';
const SOURCE_B = 'https://example.test/b.json';
const CUSTOM_MANIFEST_URL = 'https://example.test/sources.json';

// KV 键由来源 URL 派生（而不是数组下标），这里用同一套函数计算，避免测试与实现脱节。
const DATA_KEY = dataKey(SOURCE_URL);
const META_KEY = metaKey(SOURCE_URL);
/** 所有用例可能用到的 KV 键（含清单缓存），beforeEach 统一清空。 */
const CACHE_KEYS = [
  dataKey(SOURCE_URL),
  metaKey(SOURCE_URL),
  dataKey(SOURCE_A),
  metaKey(SOURCE_A),
  dataKey(SOURCE_B),
  metaKey(SOURCE_B),
  manifestKey(DEFAULT_MANIFEST),
  manifestKey(CUSTOM_MANIFEST_URL),
];
const BASE = 'https://epigram.test';
const ADMIN_TOKEN = 'dev-secret-token';

/** 上游被调用的次数，用于验证懒加载与缓存命中。 */
let upstreamCalls = 0;

/** 发请求并解析统一响应外壳。 */
async function call<T>(path: string, init?: RequestInit): Promise<{ res: Response; body: Envelope<T> }> {
  const res = await SELF.fetch(`${BASE}${path}`, init);
  const body = (await res.json()) as Envelope<T>;
  return { res, body };
}

/** 取 fetch 入参里的 URL。 */
function urlOf(input: unknown): string {
  return input instanceof Request ? input.url : String(input);
}

/** 构造一个 200 + application/json 的上游响应。 */
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * 默认上游桩：清单地址返回 `[SOURCE_URL]`，SOURCE_URL 返回 DATASET。
 * 其它地址直接抛错，以便发现漏桩（默认配置已是「来源由清单提供」）。
 */
function stubDefaultUpstream(): void {
  vi.stubGlobal('fetch', async (input: unknown) => {
    const url = urlOf(input);
    if (url === DEFAULT_MANIFEST) return jsonResponse([SOURCE_URL]);
    if (url === SOURCE_URL) {
      upstreamCalls += 1;
      return jsonResponse(DATASET);
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

beforeEach(async () => {
  upstreamCalls = 0;
  // 进程内热缓存跨用例存活，必须显式清空，否则会掩盖真实的回源行为。
  invalidateMemoryCache();
  await Promise.all(CACHE_KEYS.map((key) => env.CACHE.delete(key)));

  stubDefaultUpstream();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GET /api/health', () => {
  it('1. 返回 200 且 data.service === "epigram"', async () => {
    const { res, body } = await call<{
      service: string;
      cached: boolean;
      total: number;
      sources: { loaded: number; total: number };
    }>('/api/health');

    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(body.status).toBe(200);
    expect(body.data.service).toBe('epigram');
    expect(typeof body.data.total).toBe('number');
    // 冷启动：清单尚未缓存，无法枚举来源 → 0/0（健康检查不回源，这是预期行为）
    expect(body.data.cached).toBe(false);
    expect(body.data.sources).toEqual({ loaded: 0, total: 0 });

    // 预热之后：来源与内容都已在缓存中
    await call<Quote[]>('/api/quotes');
    const warm = await call<{
      cached: boolean;
      total: number;
      sources: { loaded: number; total: number };
    }>('/api/health');

    expect(warm.body.data.cached).toBe(true);
    expect(warm.body.data.sources).toEqual({ loaded: 1, total: 1 });
    expect(warm.body.data.total).toBe(DATASET.quotes.length);
  });
});

describe('GET /api/quotes', () => {
  it('2. 随机返回一条合法数据', async () => {
    const { res, body } = await call<Quote[]>('/api/quotes');

    expect(res.status).toBe(200);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data).toHaveLength(1);

    const item = body.data[0];
    expect(typeof item.id).toBe('string');
    expect(item.id.length).toBeGreaterThan(0);
    expect(typeof item.content).toBe('string');
    expect(item.content.length).toBeGreaterThan(0);
  });

  it('3. limit=5 返回 5 条且 id 不重复', async () => {
    const { res, body } = await call<Quote[]>('/api/quotes?limit=5');

    expect(res.status).toBe(200);
    expect(body.data).toHaveLength(5);

    const ids = body.data.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('4. category=文学 结果分类全部匹配', async () => {
    const { res, body } = await call<Quote[]>(
      `/api/quotes?category=${encodeURIComponent('文学')}&limit=5`
    );

    expect(res.status).toBe(200);
    expect(body.data.length).toBeGreaterThan(0);
    for (const item of body.data) {
      expect(item.category).toBe('文学');
    }
  });

  it('5. tag=古诗,人生 至少命中一个标签', async () => {
    const { res, body } = await call<Quote[]>(
      `/api/quotes?tag=${encodeURIComponent('古诗,人生')}&limit=5`
    );

    expect(res.status).toBe(200);
    expect(body.data.length).toBeGreaterThan(0);
    for (const item of body.data) {
      expect(item.tags?.some((tag) => tag === '古诗' || tag === '人生')).toBe(true);
    }
  });

  it('format=text 返回纯文本 content', async () => {
    const res = await SELF.fetch(`${BASE}/api/quotes?format=text`);

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/plain');
    const text = await res.text();
    expect(text.length).toBeGreaterThan(0);
  });

  it('limit 非整数返回 400', async () => {
    const { res, body } = await call<null>('/api/quotes?limit=abc');

    expect(res.status).toBe(400);
    expect(body.status).toBe(400);
    expect(body.message).toContain('limit');
  });
});

describe('GET /api/quotes/search', () => {
  it('6. q=人生 结果包含关键词', async () => {
    const { res, body } = await call<Quote[]>(
      `/api/quotes/search?q=${encodeURIComponent('人生')}`
    );

    expect(res.status).toBe(200);
    expect(body.data.length).toBeGreaterThan(0);
    for (const item of body.data) {
      const hit =
        item.content.includes('人生') ||
        (item.author?.includes('人生') ?? false) ||
        (item.source?.includes('人生') ?? false);
      expect(hit).toBe(true);
    }
  });

  it('7. 缺少 q 返回 400', async () => {
    const { res, body } = await call<null>('/api/quotes/search');

    expect(res.status).toBe(400);
    expect(body.status).toBe(400);
    expect(body.message).toContain('q');
  });
});

describe('GET /api/quotes/categories 与 /tags', () => {
  it('8. 返回去重后的分类数组', async () => {
    const { res, body } = await call<string[]>('/api/quotes/categories');

    expect(res.status).toBe(200);
    expect(Array.isArray(body.data)).toBe(true);
    expect([...body.data].sort()).toEqual(['哲学', '文学', '科技'].sort());
    expect(new Set(body.data).size).toBe(body.data.length);
  });

  it('tags 返回去重后的标签数组', async () => {
    const { res, body } = await call<string[]>('/api/quotes/tags');

    expect(res.status).toBe(200);
    expect(body.data.length).toBeGreaterThan(0);
    expect(new Set(body.data).size).toBe(body.data.length);
    expect(body.data).toContain('古诗');
  });
});

describe('POST /api/admin/refresh', () => {
  it('9. 无 Token 返回 401', async () => {
    const { res, body } = await call<null>('/api/admin/refresh', { method: 'POST' });

    expect(res.status).toBe(401);
    expect(body.status).toBe(401);
  });

  it('10. 携带正确 Token 返回 200 且刷新成功', async () => {
    const { res, body } = await call<{ refreshed: boolean; total: number }>(
      '/api/admin/refresh',
      { method: 'POST', headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } }
    );

    expect(res.status).toBe(200);
    expect(body.data.refreshed).toBe(true);
    expect(body.data.total).toBe(DATASET.quotes.length);

    const cached = await env.CACHE.get(DATA_KEY);
    expect(cached).not.toBeNull();
  });

  it('上游数据非法时返回 500，且不污染已有缓存', async () => {
    await call<Quote[]>('/api/quotes');
    const before = await env.CACHE.get(DATA_KEY);
    expect(before).not.toBeNull();

    vi.stubGlobal('fetch', async (input: unknown) => {
      // 清单正常，只有数据集内容非法
      if (urlOf(input) === DEFAULT_MANIFEST) return jsonResponse([SOURCE_URL]);
      return jsonResponse({ version: 1, quotes: [{ id: 'broken' }] });
    });

    const { res } = await call<null>('/api/admin/refresh', {
      method: 'POST',
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });

    expect(res.status).toBe(500);
    expect(await env.CACHE.get(DATA_KEY)).toBe(before);
  });
});

describe('根路径重定向', () => {
  it('访问 / 返回 302 并指向 /api/quotes/', async () => {
    const res = await SELF.fetch(`${BASE}/`, { redirect: 'manual' });

    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe(`${BASE}/api/quotes/`);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('重定向保留原始查询串', async () => {
    const res = await SELF.fetch(`${BASE}/?limit=3&format=text`, { redirect: 'manual' });

    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe(`${BASE}/api/quotes/?limit=3&format=text`);
  });

  it('跟随重定向即可拿到随机一言', async () => {
    const res = await SELF.fetch(`${BASE}/`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope<Quote[]>;
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data).toHaveLength(1);
  });

  it('HEAD / 同样重定向且无响应体', async () => {
    const res = await SELF.fetch(`${BASE}/`, { method: 'HEAD', redirect: 'manual' });

    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe(`${BASE}/api/quotes/`);
    expect(await res.text()).toBe('');
  });
});

describe('CORS', () => {
  it('11. OPTIONS 预检返回 CORS 头', async () => {
    const res = await SELF.fetch(`${BASE}/api/quotes`, { method: 'OPTIONS' });

    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('GET');
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
  });

  it('错误响应同样携带 CORS 头', async () => {
    const res = await SELF.fetch(`${BASE}/api/quotes?limit=abc`);

    expect(res.status).toBe(400);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });
});

describe('KV 懒加载', () => {
  it('12. KV 为空时首次请求自动回源，之后命中缓存', async () => {
    expect(await env.CACHE.get(DATA_KEY)).toBeNull();

    const first = await call<Quote[]>('/api/quotes');
    expect(first.res.status).toBe(200);
    expect(upstreamCalls).toBe(1);

    const second = await call<Quote[]>('/api/quotes');
    expect(second.res.status).toBe(200);
    expect(upstreamCalls).toBe(1);

    expect(await env.CACHE.get(DATA_KEY)).not.toBeNull();
    expect(await env.CACHE.get(META_KEY)).not.toBeNull();
  });
});

describe('路径尾斜杠兼容', () => {
  it('/api/quotes/ 与 /api/quotes 等价', async () => {
    const root = await call<Quote[]>('/api/quotes/');
    expect(root.res.status).toBe(200);
    expect(root.body.data).toHaveLength(1);

    const search = await call<Quote[]>(
      `/api/quotes/search/?q=${encodeURIComponent('人生')}`
    );
    expect(search.res.status).toBe(200);
    expect(search.body.data.length).toBeGreaterThan(0);
  });
});

describe('未匹配路由', () => {
  it('返回结构化 404', async () => {
    const { res, body } = await call<null>('/api/not-exist');

    expect(res.status).toBe(404);
    expect(body.status).toBe(404);
    expect(body.data).toBeNull();
  });
});

describe('安全与限流', () => {
  it('响应携带安全响应头', async () => {
    const res = await SELF.fetch(`${BASE}/api/health`);

    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
  });

  it('超过限流阈值返回 429，未超过则放行', async () => {
    let used = 0;
    const limiter = { limit: async () => ({ success: (used += 1) <= 2 }) };

    const app = new Hono<{ Bindings: Env }>();
    app.use('*', publicRateLimit());
    app.get('/', (c) => c.text('ok'));
    app.onError((err, _c) => {
      const { status, message } = toErrorResponse(err);
      return fail(status, message);
    });

    const appEnv = { PUBLIC_RATE_LIMITER: limiter } as unknown as Env;
    const hit = () => app.request('/', {}, appEnv);

    expect((await hit()).status).toBe(200);
    expect((await hit()).status).toBe(200);
    expect((await hit()).status).toBe(429);
  });

  it('缺少限流绑定时放行而不是报错', async () => {
    const app = new Hono<{ Bindings: Env }>();
    app.use('*', publicRateLimit());
    app.get('/', (c) => c.text('ok'));

    const res = await app.request('/', {}, {} as Env);
    expect(res.status).toBe(200);
  });

  it('分类取值个数超过上限返回 400', async () => {
    const many = Array.from({ length: 51 }, (_, i) => `c${i}`).join(',');
    const { res } = await call<null>(`/api/quotes?category=${many}`);

    expect(res.status).toBe(400);
  });
});

describe('resolveRootRedirect', () => {
  it('缺省返回默认目标', () => {
    expect(resolveRootRedirect({} as Env)).toBe('/api/quotes/');
  });

  it('拒绝站外地址与协议相对地址，回退默认值', () => {
    expect(resolveRootRedirect({ ROOT_REDIRECT: 'https://evil.com' } as Env)).toBe(
      '/api/quotes/'
    );
    expect(resolveRootRedirect({ ROOT_REDIRECT: '//evil.com' } as Env)).toBe('/api/quotes/');
    expect(resolveRootRedirect({ ROOT_REDIRECT: 'api/quotes' } as Env)).toBe('/api/quotes/');
  });

  it('接受站内绝对路径', () => {
    expect(resolveRootRedirect({ ROOT_REDIRECT: '/custom/path' } as Env)).toBe('/custom/path');
  });
});

describe('派生接口的 HTTP 缓存', () => {
  it('返回 Cache-Control 与 ETag，命中 If-None-Match 时返回 304', async () => {
    const first = await SELF.fetch(`${BASE}/api/quotes/categories`);
    expect(first.status).toBe(200);
    expect(first.headers.get('Cache-Control')).toContain('max-age=3600');

    const etag = first.headers.get('ETag') ?? '';
    expect(etag).not.toBe('');

    const second = await SELF.fetch(`${BASE}/api/quotes/categories`, {
      headers: { 'If-None-Match': etag },
    });
    expect(second.status).toBe(304);
    expect(second.headers.get('ETag')).toBe(etag);
    expect(second.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });
});

describe('健壮性', () => {
  it('KV 缓存损坏时自动清理并回源恢复', async () => {
    await env.CACHE.put(DATA_KEY, '{ 这不是合法 JSON', { expirationTtl: 300 });
    await env.CACHE.put(META_KEY, '同样损坏', { expirationTtl: 300 });

    const { res, body } = await call<Quote[]>('/api/quotes');

    expect(res.status).toBe(200);
    expect(body.data).toHaveLength(1);

    // 损坏值已被合法数据覆盖，元信息也被重写。
    const repaired = await env.CACHE.get(DATA_KEY);
    expect(repaired).toContain('"quotes"');
    expect(await env.CACHE.get(META_KEY)).toContain('source_url');
  });

  it('上游返回非 200 时返回 500', async () => {
    vi.stubGlobal('fetch', async (input: unknown) => {
      // 清单正常，只有数据集回源失败
      if (urlOf(input) === DEFAULT_MANIFEST) return jsonResponse([SOURCE_URL]);
      return new Response('bad gateway', { status: 502 });
    });

    const { res, body } = await call<null>('/api/quotes');

    expect(res.status).toBe(500);
    expect(body.status).toBe(500);
  });

  it('limit 超过上限时收敛，不会超出数据集总量', async () => {
    const { res, body } = await call<Quote[]>('/api/quotes?limit=999');

    expect(res.status).toBe(200);
    expect(body.data.length).toBe(DATASET.quotes.length);
  });

  it('上游 304 时复用缓存并续期，不重新写入正文', async () => {
    const etagValue = 'W/"dataset-v1"';
    let sawConditional = false;

    // 第一次：上游返回 200 + ETag，应完整写入 KV。
    const okWithEtag = (): Response =>
      new Response(JSON.stringify(DATASET), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ETag: etagValue },
      });

    vi.stubGlobal('fetch', async (input: unknown) => {
      if (urlOf(input) === DEFAULT_MANIFEST) return jsonResponse([SOURCE_URL]);
      upstreamCalls += 1;
      return okWithEtag();
    });

    const first = await SELF.fetch(`${BASE}/api/quotes`);
    expect(first.status).toBe(200);
    expect(upstreamCalls).toBe(1);

    // 第二次：仅当请求带上 If-None-Match 时返回 304，用于验证条件请求生效。
    vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
      if (urlOf(input) === DEFAULT_MANIFEST) return jsonResponse([SOURCE_URL]);
      if (new Headers(init?.headers).get('If-None-Match') === etagValue) {
        sawConditional = true;
        return new Response(null, { status: 304, headers: { ETag: etagValue } });
      }
      return okWithEtag();
    });

    const refreshed = await call<{ refreshed: boolean; total: number }>('/api/admin/refresh', {
      method: 'POST',
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });

    expect(sawConditional).toBe(true);
    expect(refreshed.res.status).toBe(200);
    expect(refreshed.body.data.total).toBe(DATASET.quotes.length);
  });

  it('上游 304 但本地无缓存时返回 500 而不是死循环', async () => {
    vi.stubGlobal('fetch', async (input: unknown) => {
      if (urlOf(input) === DEFAULT_MANIFEST) return jsonResponse([SOURCE_URL]);
      return new Response(null, { status: 304 });
    });

    const { res } = await call<null>('/api/quotes');

    expect(res.status).toBe(500);
  });
});

describe('GET /api/admin/stats', () => {
  it('携带正确 Token 时返回统计数据', async () => {
    const { res, body } = await call<{
      total: number;
      categories: number;
      tags: number;
      version: number;
      updated_at: string;
      sources: { url: string; total: number }[];
      failures: { url: string }[];
      manifest: { url: string; count: number; error: string | null } | null;
    }>('/api/admin/stats', { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } });

    expect(res.status).toBe(200);
    expect(body.data.total).toBe(DATASET.quotes.length);
    expect(body.data.categories).toBe(3);
    expect(body.data.version).toBe(1);
    expect(body.data.updated_at).toBe(DATASET.updated_at);
    // 默认配置：来源由默认清单提供（1 个），无失败项
    expect(body.data.sources).toHaveLength(1);
    expect(body.data.failures).toHaveLength(0);
    expect(body.data.manifest).toEqual({ url: DEFAULT_MANIFEST, count: 1, error: null });
  });
});

describe('多来源数据集', () => {
  /** 用真实的 KV binding + 指定的来源 / 清单配置拼一个最小 env。 */
  function sourceEnv(urls: string[], manifestUrl = ''): Env {
    return {
      CACHE: env.CACHE,
      DATA_SOURCES: JSON.stringify(urls),
      DATA_MANIFEST_URL: manifestUrl,
    } as unknown as Env;
  }

  /** 按 URL 返回不同数据集的上游桩；未命中的 URL 返回 404。 */
  function stubUpstream(map: Record<string, unknown>): void {
    vi.stubGlobal('fetch', async (input: unknown) => {
      const body = map[urlOf(input)];
      if (body === undefined) return new Response('not found', { status: 404 });
      return jsonResponse(body);
    });
  }

  it('多个来源合并成一个总池，且各自独立写入 KV', async () => {
    stubUpstream({ [SOURCE_A]: DATASET, [SOURCE_B]: DATASET_B });

    const result = await loadDatasetWithMeta(sourceEnv([SOURCE_A, SOURCE_B]));

    expect(result.failures).toHaveLength(0);
    expect(result.sources).toHaveLength(2);
    expect(result.dataset.quotes).toHaveLength(DATASET.quotes.length + 1);
    expect(result.cached).toBe(false);
    // 聚合字段取各来源的较大值
    expect(result.dataset.version).toBe(DATASET_B.version);
    expect(result.dataset.updated_at).toBe(DATASET_B.updated_at);

    // 每个来源各有一份独立缓存，互不覆盖（键由 URL 派生）
    expect(await env.CACHE.get(dataKey(SOURCE_A))).not.toBeNull();
    expect(await env.CACHE.get(dataKey(SOURCE_B))).not.toBeNull();
  });

  it('部分来源失败时跳过它，其余来源照常可用', async () => {
    vi.stubGlobal('fetch', async (input: unknown) => {
      if (urlOf(input) === SOURCE_B) throw new Error('network down');
      return jsonResponse(DATASET);
    });

    const result = await loadDatasetWithMeta(sourceEnv([SOURCE_A, SOURCE_B]));

    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].url).toBe(SOURCE_A);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].url).toBe(SOURCE_B);
    expect(result.dataset.quotes).toHaveLength(DATASET.quotes.length);
  });

  it('全部来源失败时抛错（由顶层转成 500）', async () => {
    vi.stubGlobal('fetch', async () => new Response('boom', { status: 503 }));

    await expect(loadDatasetWithMeta(sourceEnv([SOURCE_A, SOURCE_B]))).rejects.toThrow(
      /均加载失败/
    );
  });

  it('每个来源各自命中 KV，不重复回源', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async (input: unknown) => {
      calls += 1;
      return jsonResponse(urlOf(input) === SOURCE_B ? DATASET_B : DATASET);
    });

    const scoped = sourceEnv([SOURCE_A, SOURCE_B]);
    await loadDatasetWithMeta(scoped);
    expect(calls).toBe(2);

    // 清掉热缓存后应命中各来源的 KV，而不是再次访问上游
    invalidateMemoryCache();
    const second = await loadDatasetWithMeta(scoped);

    expect(calls).toBe(2);
    expect(second.cached).toBe(true);
    expect(second.dataset.quotes).toHaveLength(DATASET.quotes.length + 1);
  });

  it('DATA_SOURCES 非法时直接报错，而不是静默回退到默认来源', async () => {
    const broken = { CACHE: env.CACHE, DATA_SOURCES: 'not-json' } as unknown as Env;

    await expect(loadDatasetWithMeta(broken)).rejects.toThrow(/DATA_SOURCES/);
  });

  it('来源重排后仍各自命中自己的缓存，不会串数据', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async (input: unknown) => {
      calls += 1;
      return jsonResponse(urlOf(input) === SOURCE_B ? DATASET_B : DATASET);
    });

    await loadDatasetWithMeta(sourceEnv([SOURCE_A, SOURCE_B]));
    expect(calls).toBe(2);

    // 清掉热缓存后颠倒顺序：键若按下标编，就会把 A 的缓存当成 B 的数据返回
    invalidateMemoryCache();
    const reversed = await loadDatasetWithMeta(sourceEnv([SOURCE_B, SOURCE_A]));

    expect(calls).toBe(2); // 两边都命中各自缓存，无需回源
    expect(reversed.cached).toBe(true);
    expect(reversed.sources.find((item) => item.url === SOURCE_B)?.total).toBe(
      DATASET_B.quotes.length
    );
    expect(reversed.sources.find((item) => item.url === SOURCE_A)?.total).toBe(
      DATASET.quotes.length
    );
  });

  it('缓存声明的来源地址与当前来源不一致时视为未命中并回源', async () => {
    // 人为把 B 的数据写到 A 的键上，并声明来源是 B
    await env.CACHE.put(dataKey(SOURCE_A), JSON.stringify(DATASET_B), { expirationTtl: 300 });
    await env.CACHE.put(metaKey(SOURCE_A), JSON.stringify({ loaded_at: 1, source_url: SOURCE_B }), {
      expirationTtl: 300,
    });

    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls += 1;
      return jsonResponse(DATASET);
    });

    const result = await loadDatasetWithMeta(sourceEnv([SOURCE_A]));

    expect(calls).toBe(1); // 来源不匹配 → 回源
    expect(result.dataset.quotes).toHaveLength(DATASET.quotes.length); // 拿到 A 的数据而非 B 的
  });
});

describe('来源清单（动态来源）', () => {
  function sourceEnv(urls: string[], manifestUrl: string): Env {
    return {
      CACHE: env.CACHE,
      DATA_SOURCES: JSON.stringify(urls),
      DATA_MANIFEST_URL: manifestUrl,
    } as unknown as Env;
  }

  /** 清单地址返回指定响应；SOURCE_B 返回 DATASET_B，其余地址返回 DATASET。传工厂函数以免 Response 被重复消费。 */
  function stubWithManifest(manifestResponse: () => Response): void {
    vi.stubGlobal('fetch', async (input: unknown) => {
      const url = urlOf(input);
      if (url === CUSTOM_MANIFEST_URL) return manifestResponse();
      if (url === SOURCE_B) return jsonResponse(DATASET_B);
      return jsonResponse(DATASET);
    });
  }

  it('清单里的来源会与 DATA_SOURCES 合并', async () => {
    stubWithManifest(() => jsonResponse([SOURCE_B]));

    const result = await loadDatasetWithMeta(sourceEnv([SOURCE_A], CUSTOM_MANIFEST_URL));

    expect(result.manifest).toEqual({ url: CUSTOM_MANIFEST_URL, count: 1, error: null });
    expect(result.sources).toHaveLength(2);
    expect(result.dataset.quotes).toHaveLength(DATASET.quotes.length + 1);
    expect(await env.CACHE.get(manifestKey(CUSTOM_MANIFEST_URL))).not.toBeNull();
  });

  it('清单显式留空时关闭清单（manifest 为 null）', async () => {
    vi.stubGlobal('fetch', async () => jsonResponse(DATASET));

    const result = await loadDatasetWithMeta(sourceEnv([SOURCE_A], ''));

    expect(result.manifest).toBeNull();
  });

  it('清单不可用时降级为仅用 DATA_SOURCES，并记录错误', async () => {
    stubWithManifest(() => new Response('boom', { status: 500 }));

    const result = await loadDatasetWithMeta(sourceEnv([SOURCE_A], CUSTOM_MANIFEST_URL));

    expect(result.manifest?.error).toBeTruthy();
    expect(result.manifest?.count).toBe(0);
    expect(result.dataset.quotes).toHaveLength(DATASET.quotes.length); // 服务仍然可用
    expect(result.failures).toHaveLength(0);
  });

  it('清单内容非法时沿用上一份合法清单，且不覆盖缓存', async () => {
    const scoped = sourceEnv([SOURCE_A], CUSTOM_MANIFEST_URL);
    stubWithManifest(() => jsonResponse([SOURCE_B]));
    await loadDatasetWithMeta(scoped);

    // 清单变成非法 JSON，并强制刷新
    invalidateMemoryCache();
    stubWithManifest(() => new Response('not-json', { status: 200 }));
    const result = await refreshAllSources(scoped);

    expect(result.manifest?.error).toContain('格式非法');
    expect(result.manifest?.count).toBe(1); // 沿用上一份合法清单
    expect(result.dataset.quotes).toHaveLength(DATASET.quotes.length + 1);
  });

  it('既没有静态来源也没有清单时给出明确错误', async () => {
    const bare = {
      CACHE: env.CACHE,
      DATA_SOURCES: '[]',
      DATA_MANIFEST_URL: '',
    } as unknown as Env;

    await expect(loadDatasetWithMeta(bare)).rejects.toThrow(/未解析到任何数据来源/);
  });
});

describe('来源配置解析', () => {
  it('未配置或显式空数组的 DATA_SOURCES 都不设静态来源（交给清单）', () => {
    expect(resolveBaselineSources({} as Env)).toEqual([]);
    expect(resolveBaselineSources({ DATA_SOURCES: '[]' } as Env)).toEqual([]);
  });

  it('DATA_SOURCES 按序解析并去重', () => {
    expect(resolveBaselineSources({ DATA_SOURCES: '["a", "b", "a"]' } as Env)).toEqual(['a', 'b']);
  });

  it('未配置 DATA_MANIFEST_URL 时回退到默认清单地址', () => {
    expect(resolveManifestUrl({} as Env)).toBe(DEFAULT_MANIFEST);
  });

  it('显式留空 DATA_MANIFEST_URL 时关闭清单', () => {
    expect(resolveManifestUrl({ DATA_MANIFEST_URL: '' } as Env)).toBeNull();
    expect(resolveManifestUrl({ DATA_MANIFEST_URL: '   ' } as Env)).toBeNull();
  });

  it('自定义 DATA_MANIFEST_URL 时优先使用它（并去掉首尾空白）', () => {
    expect(resolveManifestUrl({ DATA_MANIFEST_URL: ' https://x/y.json ' } as Env)).toBe(
      'https://x/y.json'
    );
  });
});
