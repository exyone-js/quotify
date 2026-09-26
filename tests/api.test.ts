import { env, SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface Envelope<T> {
  status: number;
  message: string;
  data: T;
  ts: number;
}

interface Epigram {
  id: string;
  content: string;
  source?: string;
  author?: string;
  category?: string;
  tags?: string[];
}

/** 固定的 mock 数据集：mock 掉 raw.githubusercontent.com 的返回。 */
const DATASET = {
  version: 1,
  updated_at: '2026-09-26T12:00:00Z',
  epigrams: [
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

const DATA_KEY = 'epigram:data:v1';
const META_KEY = 'epigram:meta:v1';
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

beforeEach(async () => {
  upstreamCalls = 0;
  await env.CACHE.delete(DATA_KEY);
  await env.CACHE.delete(META_KEY);

  vi.stubGlobal('fetch', async (input: unknown) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes('raw.githubusercontent.com')) {
      upstreamCalls += 1;
      return new Response(JSON.stringify(DATASET), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GET /api/health', () => {
  it('1. 返回 200 且 data.service === "epigram"', async () => {
    const { res, body } = await call<{ service: string; cached: boolean; total: number }>(
      '/api/health'
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(body.status).toBe(200);
    expect(body.data.service).toBe('epigram');
    expect(typeof body.data.total).toBe('number');
  });
});

describe('GET /api/quotes', () => {
  it('2. 随机返回一条合法数据', async () => {
    const { res, body } = await call<Epigram[]>('/api/quotes');

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
    const { res, body } = await call<Epigram[]>('/api/quotes?limit=5');

    expect(res.status).toBe(200);
    expect(body.data).toHaveLength(5);

    const ids = body.data.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('4. category=文学 结果分类全部匹配', async () => {
    const { res, body } = await call<Epigram[]>(
      `/api/quotes?category=${encodeURIComponent('文学')}&limit=5`
    );

    expect(res.status).toBe(200);
    expect(body.data.length).toBeGreaterThan(0);
    for (const item of body.data) {
      expect(item.category).toBe('文学');
    }
  });

  it('5. tag=古诗,人生 至少命中一个标签', async () => {
    const { res, body } = await call<Epigram[]>(
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
    const { res, body } = await call<Epigram[]>(
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
    expect(body.data.total).toBe(DATASET.epigrams.length);

    const cached = await env.CACHE.get(DATA_KEY);
    expect(cached).not.toBeNull();
  });

  it('上游数据非法时返回 500，且不污染已有缓存', async () => {
    await call<Epigram[]>('/api/quotes');
    const before = await env.CACHE.get(DATA_KEY);
    expect(before).not.toBeNull();

    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ version: 1, epigrams: [{ id: 'broken' }] }), { status: 200 })
    );

    const { res } = await call<null>('/api/admin/refresh', {
      method: 'POST',
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });

    expect(res.status).toBe(500);
    expect(await env.CACHE.get(DATA_KEY)).toBe(before);
  });
});

describe('CORS', () => {
  it('11. OPTIONS 预检返回 CORS 头', async () => {
    const res = await SELF.fetch(`${BASE}/api/quotes`, { method: 'OPTIONS' });

    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('GET');
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
  });
});

describe('KV 懒加载', () => {
  it('12. KV 为空时首次请求自动回源，之后命中缓存', async () => {
    expect(await env.CACHE.get(DATA_KEY)).toBeNull();

    const first = await call<Epigram[]>('/api/quotes');
    expect(first.res.status).toBe(200);
    expect(upstreamCalls).toBe(1);

    const second = await call<Epigram[]>('/api/quotes');
    expect(second.res.status).toBe(200);
    expect(upstreamCalls).toBe(1);

    expect(await env.CACHE.get(DATA_KEY)).not.toBeNull();
    expect(await env.CACHE.get(META_KEY)).not.toBeNull();
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
