import { MAX_CSV_VALUES, MAX_OFFSET, MAX_PARAM_LENGTH } from '../config';

/** 业务错误：携带 HTTP 状态码，由顶层 onError 统一转成响应。 */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }

  static badRequest(message: string): ApiError {
    return new ApiError(400, message);
  }

  static unauthorized(message = '未授权。'): ApiError {
    return new ApiError(401, message);
  }

  static notFound(message = '未找到。'): ApiError {
    return new ApiError(404, message);
  }

  static tooManyRequests(message = '请求过于频繁，请稍后再试。'): ApiError {
    return new ApiError(429, message);
  }

  static internal(message = '服务器内部错误。'): ApiError {
    return new ApiError(500, message);
  }
}

/** 上游（GitHub）数据获取或数据校验失败。 */
export class UpstreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpstreamError';
  }
}

/** 把任意异常映射为 `{ status, message }`。 */
export function toErrorResponse(err: unknown): { status: number; message: string } {
  if (err instanceof ApiError) {
    return { status: err.status, message: err.message };
  }
  if (err instanceof UpstreamError) {
    return { status: 500, message: err.message };
  }
  if (err instanceof Error) {
    return { status: 500, message: err.message || '服务器内部错误。' };
  }
  return { status: 500, message: '服务器内部错误。' };
}

/**
 * 纯十进制整数（可选正负号）。
 *
 * 不用 `Number()` + `Number.isInteger()`：那会把 `0x10`、`1e3`、`0b11`
 * 之类的非十进制写法也判为合法，导致「看起来是 3，实际是 1000」这类意外。
 */
const DECIMAL_INTEGER = /^[+-]?\d+$/;

/**
 * 解析区间型整数参数：
 * - 缺省 → default
 * - 非十进制整数 / 小于最小值 → 400
 * - 大于最大值 → 收敛到最大值
 */
export function parseLimit(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
  name = 'limit',
): number {
  if (raw === undefined || raw.trim() === '') return fallback;

  const text = raw.trim();
  if (!DECIMAL_INTEGER.test(text)) {
    throw ApiError.badRequest(`参数 ${name} 必须是整数。`);
  }

  const value = Number(text);
  if (value < min) {
    throw ApiError.badRequest(`参数 ${name} 不能小于 ${min}。`);
  }
  return Math.min(value, max);
}

/**
 * 解析非负整数偏移量，缺省为 0，并夹紧到 `MAX_OFFSET`。
 *
 * 超大 offset 没有任何业务意义，却会白白扫一遍结果集，故直接拒绝而不是静默截断。
 */
export function parseOffset(raw: string | undefined, name = 'offset'): number {
  if (raw === undefined || raw.trim() === '') return 0;

  const text = raw.trim();
  if (!DECIMAL_INTEGER.test(text)) {
    throw ApiError.badRequest(`参数 ${name} 必须是不小于 0 的整数。`);
  }

  const value = Number(text);
  if (value < 0) {
    throw ApiError.badRequest(`参数 ${name} 必须是不小于 0 的整数。`);
  }
  if (value > MAX_OFFSET) {
    throw ApiError.badRequest(`参数 ${name} 不能大于 ${MAX_OFFSET}。`);
  }
  return value;
}

/** 解析单个自由文本参数：去掉首尾空白，并拒绝超长输入。 */
export function parseText(raw: string | undefined, name: string): string {
  const text = (raw ?? '').trim();
  if (text.length > MAX_PARAM_LENGTH) {
    throw ApiError.badRequest(`参数 ${name} 长度不能超过 ${MAX_PARAM_LENGTH} 个字符。`);
  }
  return text;
}

/**
 * 解析逗号分隔的多值参数：去空、去重；无有效值时返回 undefined。
 *
 * 单个取值还受 `MAX_PARAM_LENGTH` 限制：超长关键词会把子串匹配放大成 O(n·m)，
 * 而正常业务关键词远短于此。
 */
export function parseCsv(raw: string | undefined, name = 'filter'): string[] | undefined {
  if (!raw) return undefined;
  const values = raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (values.length === 0) return undefined;

  for (const value of values) {
    if (value.length > MAX_PARAM_LENGTH) {
      throw ApiError.badRequest(`参数 ${name} 的单个取值不能超过 ${MAX_PARAM_LENGTH} 个字符。`);
    }
  }

  const unique = [...new Set(values)];
  // 限制取值个数：避免超长参数把过滤阶段的 includes 比较放大成 O(n·m)。
  if (unique.length > MAX_CSV_VALUES) {
    throw ApiError.badRequest(`参数 ${name} 最多支持 ${MAX_CSV_VALUES} 个取值。`);
  }
  return unique;
}
