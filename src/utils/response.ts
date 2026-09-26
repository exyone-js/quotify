/** 统一响应外壳：所有接口（含错误）都返回该结构。 */
export interface ApiEnvelope<T> {
  status: number;
  message: string;
  data: T;
  ts: number;
}

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' } as const;

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

/** 纯文本响应，用于 `format=text`。 */
export function plainText(content: string): Response {
  return new Response(content, {
    status: 200,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

/**
 * 内容稳定的成功响应：附带 `Cache-Control` 与 `ETag`。
 * 供分类 / 标签这类「同一数据集内结果不变」的接口使用，让浏览器与 CDN 直接命中。
 */
export function cachedOk<T>(data: T, etag: string, maxAge: number): Response {
  const res = ok(data);
  res.headers.set('Cache-Control', `public, max-age=${maxAge}`);
  res.headers.set('ETag', etag);
  return res;
}

/** 客户端 ETag 命中时的 304 响应（无正文）。 */
export function notModified(etag: string, maxAge: number): Response {
  return new Response(null, {
    status: 304,
    headers: {
      ETag: etag,
      'Cache-Control': `public, max-age=${maxAge}`,
    },
  });
}
