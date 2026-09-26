/** 统一响应外壳：所有接口（含错误）都返回该结构。 */
export interface ApiEnvelope<T> {
  status: number;
  message: string;
  data: T;
  ts: number;
}

/** 成功响应：`{ status, message, data, ts }`。 */
export function ok<T>(data: T, message = 'ok.'): Response {
  const body: ApiEnvelope<T> = { status: 200, message, data, ts: Date.now() };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

/** 错误响应：保持同一外壳，`data` 为 null。 */
export function fail(status: number, message: string): Response {
  const body: ApiEnvelope<null> = { status, message, data: null, ts: Date.now() };
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

/** 纯文本响应，用于 `format=text`。 */
export function plainText(content: string): Response {
  return new Response(content, {
    status: 200,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
