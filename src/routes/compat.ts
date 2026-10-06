import { Hono } from 'hono';
import { fingerprint } from '../config';
import { loadDataset } from '../data/loader';
import { randomPick } from '../data/store';
import type { Quote } from '../data/types';
import { publicRateLimit } from '../middleware/rateLimit';
import type { Env } from '../types/env';
import { ApiError, parseLimit } from '../utils/error';
import { bareJson, plainText } from '../utils/response';

/**
 * Hitokoto（一言）兼容层。
 *
 * Quotify 的原生响应是「信封 + 数组」，与 `v1.hitokoto.cn` 的裸对象契约不同，
 * 现有的一言客户端直接接入会取不到字段。这一层只做**字段与参数映射**，
 * 不改动原生接口，让老客户端可以零改动迁移。
 *
 * 映射关系见 README「Hitokoto 兼容层」。
 */

/** Hitokoto 分类码 → 含义（a..l），也是 `c` 参数的取值。 */
const CODE_TO_CATEGORY: Record<string, string> = {
  a: '动画',
  b: '漫画',
  c: '游戏',
  d: '文学',
  e: '原创',
  f: '网络',
  g: '其他',
  h: '影视',
  i: '诗词',
  j: '网易云',
  k: '哲学',
  l: '抖机灵',
};

/** 分类 → 分类码（未收录的分类统一归到 `g` 其他）。 */
const CATEGORY_TO_CODE: Record<string, string> = Object.fromEntries(
  Object.entries(CODE_TO_CATEGORY).map(([code, category]) => [category, code]),
);

/** 未收录分类的兜底码：`g`（其他）。 */
const DEFAULT_CATEGORY_CODE = 'g';

/** JSONP 回调名白名单：必须是合法 JS 标识符，避免把响应变成可执行的任意脚本。 */
const CALLBACK_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;

const compat = new Hono<{ Bindings: Env }>();

compat.use('*', publicRateLimit());

/** 解析 `c` 参数：只接受 a..l 的字母，多个值之间用逗号分隔（OR）。 */
function parseCategoryCodes(raw: string | undefined): string[] | null {
  if (!raw) return null;

  const codes = [
    ...new Set(
      raw
        .split(',')
        .map((item) => item.trim().toLowerCase())
        .filter((item) => item.length > 0),
    ),
  ];
  if (codes.length === 0) return null;

  for (const code of codes) {
    if (!(code in CODE_TO_CATEGORY)) {
      throw ApiError.badRequest(`参数 c 只支持 a-l 的分类码，收到：${code}。`);
    }
  }
  return codes;
}

/** 解析 `encode` 参数：json（默认）/ text / js。 */
function parseEncode(raw: string | undefined): 'json' | 'text' | 'js' {
  const value = raw?.trim() ?? '';
  if (value === '' || value === 'json') return 'json';
  if (value === 'text' || value === 'js') return value;
  throw ApiError.badRequest("参数 encode 只支持 'json'、'text' 或 'js'。");
}

/** 把 Quotify 的 quote 映射成 Hitokoto 的响应对象。 */
function toHitokoto(quote: Quote, createdAt: string): Record<string, unknown> {
  return {
    // Hitokoto 的 id 是数字：由 id 指纹稳定派生，保证同一条始终得到同一个数字。
    id: parseInt(fingerprint(quote.id).slice(0, 7), 16),
    uuid: quote.id,
    hitokoto: quote.content,
    type: CATEGORY_TO_CODE[quote.category ?? ''] ?? DEFAULT_CATEGORY_CODE,
    from: quote.source ?? '',
    from_who: quote.author ?? '',
    creator: 'quotify',
    creator_uid: 0,
    reviewer: 0,
    commit_from: 'api',
    created_at: createdAt,
    length: quote.content.length,
  };
}

/**
 * GET /v1/hitokoto —— 随机一条，以 Hitokoto 契约返回。
 *
 * 支持参数：`c`（分类码 a-l，逗号分隔）、`encode`、`callback`（encode=js 时必填）、
 * `min_length`、`max_length`。
 */
compat.get('/', async (c) => {
  const codes = parseCategoryCodes(c.req.query('c'));
  const encode = parseEncode(c.req.query('encode'));
  const minLength = parseLimit(c.req.query('min_length'), 0, 0, 10_000, 'min_length');
  const maxLength = parseLimit(c.req.query('max_length'), 0, 0, 10_000, 'max_length');

  if (maxLength > 0 && maxLength < minLength) {
    throw ApiError.badRequest('参数 max_length 不能小于 min_length。');
  }

  const dataset = await loadDataset(c.env);

  const categories = codes
    ?.map((code) => CODE_TO_CATEGORY[code] ?? '')
    .filter((category) => category.length > 0);
  let pool = dataset.quotes;
  if (categories !== undefined && categories.length > 0) {
    pool = pool.filter((quote) => categories.includes(quote.category ?? ''));
  }
  if (minLength > 0) {
    pool = pool.filter((quote) => quote.content.length >= minLength);
  }
  if (maxLength > 0) {
    pool = pool.filter((quote) => quote.content.length <= maxLength);
  }
  if (pool.length === 0) {
    throw ApiError.notFound('没有符合条件的一言。');
  }

  const picked = randomPick(pool, 1)[0];
  if (picked === undefined) {
    throw ApiError.notFound('没有符合条件的一言。');
  }

  const payload = toHitokoto(picked, dataset.updated_at);

  if (encode === 'text') {
    return plainText(picked.content);
  }

  if (encode === 'js') {
    const callback = (c.req.query('callback') ?? '').trim();
    if (!CALLBACK_PATTERN.test(callback)) {
      throw ApiError.badRequest(
        'encode=js 时必须提供合法的 callback 参数（JS 标识符，最多 64 个字符）。',
      );
    }
    return new Response(`${callback}(${JSON.stringify(payload)});`, {
      status: 200,
      headers: {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  }

  // 裸对象：Hitokoto 客户端直接读 `hitokoto` / `type`，不能套统一外壳。
  return bareJson(payload);
});

export default compat;
