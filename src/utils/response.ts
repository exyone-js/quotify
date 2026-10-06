/** 统一响应外壳：所有接口（含错误）都返回该结构。 */
export interface ApiEnvelope<T> {
  status: number;
  message: string;
  data: T;
  ts: number;
}

/**
 * 默认 JSON 头。
 *
 * `no-store` 是**默认策略**而非遗漏：随机接口（`ok`）每次都应返回不同结果，
 * 一旦被中间代理 / CDN / 浏览器缓存，所有用户就会看到同一条一言。
 * 只有 `cachedOk` 这类「内容稳定」的响应才显式覆盖成可缓存。
 */
const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
} as const;

/** 按统一外壳构造 JSON 响应，供成功 / 失败共用。 */
function envelope<T>(status: number, message: string, data: T): Response {
  const body: ApiEnvelope<T> = { status, message, data, ts: Date.now() };
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

/** 成功响应：`{ status, message, data, ts }`。 */
export function ok<T>(data: T, message = 'ok.'): Response {
  return envelope(200, message, data);
}

/** 错误响应：保持同一外壳，`data` 为 null。 */
export function fail(status: number, message: string): Response {
  return envelope(status, message, null);
}

/**
 * 裸 JSON 响应（不套统一外壳）。
 *
 * 仅供兼容层使用：Hitokoto 客户端直接读 `body.hitokoto` / `body.type`，
 * 套上 `{ status, message, data, ts }` 就取不到任何字段了。
 * 原生接口一律用 `ok()`，不在这里。
 */
export function bareJson(data: unknown): Response {
  return new Response(JSON.stringify(data), { status: 200, headers: JSON_HEADERS });
}

/** 纯文本响应，用于 `format=text`；同样禁止缓存（内容是随机的）。 */
export function plainText(content: string): Response {
  return new Response(content, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

/**
 * 内容稳定的成功响应：附带 `Cache-Control` 与 `ETag`。
 * 供分类 / 标签这类「同一数据集内结果不变」的接口使用，让浏览器与 CDN 直接命中。
 *
 * `Vary: Accept-Encoding` 是必须的：响应可能被 gzip / br 压缩后再缓存，
 * 若 CDN 不按 `Accept-Encoding` 分桶，就会把压缩版发给不支持的客户端。
 */
export function cachedOk<T>(data: T, etag: string, maxAge: number): Response {
  const res = ok(data);
  res.headers.set('Cache-Control', `public, max-age=${maxAge}`);
  res.headers.set('ETag', etag);
  res.headers.set('Vary', 'Accept-Encoding');
  return res;
}

/** 客户端 ETag 命中时的 304 响应（无正文）。 */
export function notModified(etag: string, maxAge: number): Response {
  return new Response(null, {
    status: 304,
    headers: {
      ETag: etag,
      'Cache-Control': `public, max-age=${maxAge}`,
      Vary: 'Accept-Encoding',
    },
  });
}

/**
 * 宽松的 ETag 比较：容忍客户端回传的多种变形。
 *
 * - 我们的 ETag 带 `W/` 弱标记，客户端可能原样带回，也可能只回传引号部分；
 * - 部分代理会加 `-gzip` 之类的后缀；
 * - `If-None-Match` 还可能是逗号分隔的多值列表（如 `W/"a", "b"`）。
 */
export function etagMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false;

  const normalize = (value: string): string => {
    const trimmed = value.trim();
    return trimmed.startsWith('W/') ? trimmed.slice(2) : trimmed;
  };

  const target = normalize(etag);
  return header
    .split(',')
    .map((candidate) => normalize(candidate))
    .some((candidate) => candidate === target || candidate.startsWith(`${target.slice(0, -1)}-`));
}
