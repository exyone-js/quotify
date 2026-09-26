import { MAX_CSV_VALUES } from '../config';

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
 * 解析区间型整数参数：
 * - 缺省 → default
 * - 非整数 / 小于最小值 → 400
 * - 大于最大值 → 收敛到最大值
 */
export function parseLimit(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
  name = 'limit'
): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw ApiError.badRequest(`参数 ${name} 必须是整数。`);
  }
  if (value < min) {
    throw ApiError.badRequest(`参数 ${name} 不能小于 ${min}。`);
  }
  return Math.min(value, max);
}

/** 解析非负整数偏移量，缺省为 0。 */
export function parseOffset(raw: string | undefined, name = 'offset'): number {
  if (raw === undefined || raw.trim() === '') return 0;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw ApiError.badRequest(`参数 ${name} 必须是不小于 0 的整数。`);
  }
  return value;
}

/** 解析逗号分隔的多值参数：去空、去重；无有效值时返回 undefined。 */
export function parseCsv(raw: string | undefined, name = 'filter'): string[] | undefined {
  if (!raw) return undefined;
  const values = raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (values.length === 0) return undefined;

  const unique = [...new Set(values)];
  // 限制取值个数：避免超长参数把过滤阶段的 includes 比较放大成 O(n·m)。
  if (unique.length > MAX_CSV_VALUES) {
    throw ApiError.badRequest(`参数 ${name} 最多支持 ${MAX_CSV_VALUES} 个取值。`);
  }
  return unique;
}
