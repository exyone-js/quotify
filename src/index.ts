import { Hono } from 'hono';
import { peekCache } from './data/loader';
import { cors } from './middleware/cors';
import adminRoutes from './routes/admin';
import quotesRoutes from './routes/quotes';
import type { Env } from './types/env';
import { toErrorResponse } from './utils/error';
import { fail, ok } from './utils/response';

// Hono 的 strict 默认为 true，会把 `/api/quotes` 与 `/api/quotes/` 视作两条不同路由。
// 对公开 API 来说尾斜杠应当被容忍（浏览器、代理、手写 URL 都可能带上），故显式关闭。
// 关闭后 getPath 会把请求路径的尾斜杠归一化掉，子路由同理。
const app = new Hono<{ Bindings: Env }>({ strict: false });

// 1. CORS：所有接口（含错误响应）都带跨域头，并短路 OPTIONS 预检。
app.use('*', cors());

// 2. 健康检查：只读缓存状态，不触发回源。
app.get('/api/health', async (c) => {
  const { cached, loadedAt, total } = await peekCache(c.env);
  return ok({
    service: 'epigram',
    cached,
    cache_loaded_at: loadedAt,
    total,
  });
});

// 3. 业务路由。
app.route('/api/quotes', quotesRoutes);
app.route('/api/admin', adminRoutes);

// 4. 未匹配路由统一 404。
app.notFound((c) => {
  const { pathname } = new URL(c.req.url);
  return fail(404, `未找到接口：${c.req.method} ${pathname}`);
});

// 5. 顶层错误处理：统一 JSON 结构 + 非阻塞日志。
app.onError((err, c) => {
  const { status, message } = toErrorResponse(err);
  const line = `[epigram] ${c.req.method} ${c.req.url} -> ${status} ${message}`;

  try {
    c.executionCtx.waitUntil(Promise.resolve(console.error(line, err)));
  } catch {
    console.error(line, err);
  }

  return fail(status, message);
});

export default app;
