import { Hono } from 'hono';
import { resolveRootRedirect } from './config';
import { peekCache } from './data/loader';
import { cors } from './middleware/cors';
import { securityHeaders } from './middleware/security';
import adminRoutes from './routes/admin';
import quotesRoutes from './routes/quotes';
import type { Env } from './types/env';
import { toErrorResponse } from './utils/error';
import { fail, ok } from './utils/response';

// Hono 的 strict 默认为 true，会把 `/api/quotes` 与 `/api/quotes/` 视作两条不同路由。
// 对公开 API 来说尾斜杠应当被容忍（浏览器、代理、手写 URL 都可能带上），故显式关闭。
// 关闭后 getPath 会把请求路径的尾斜杠归一化掉，子路由同理。
const app = new Hono<{ Bindings: Env }>({ strict: false });

// 1. 安全响应头：放在最外层，保证 CORS 短路 OPTIONS 时也带上。
app.use('*', securityHeaders());

// 2. CORS：所有接口（含错误响应）都带跨域头，并短路 OPTIONS 预检。
app.use('*', cors());

// 3. 健康检查：只读缓存状态，不触发回源。
app.get('/api/health', async (c) => {
  const { cached, loadedAt, total, sourcesLoaded, sourcesTotal } = await peekCache(c.env);
  return ok({
    service: 'quotify',
    environment: c.env.ENVIRONMENT ?? 'unknown',
    cached,
    cache_loaded_at: loadedAt,
    total,
    // 数据源就绪情况：已缓存 / 配置总数。
    sources: { loaded: sourcesLoaded, total: sourcesTotal },
  });
});

// 4. 根路径重定向：直接访问根域（`/`）时 302 到公开随机接口，避免裸 404。
//    仅改写 pathname、保留原始查询串，因此 `/?limit=5` 等价于 `/api/quotes/?limit=5`。
//    目标可通过 ROOT_REDIRECT 配置，且只允许站内绝对路径（见 resolveRootRedirect）。
//    Hono 会把 HEAD 请求按 GET 处理并剥离响应体，故无需额外注册 HEAD。
app.get('/', (c) => {
  const url = new URL(c.req.url);
  url.pathname = resolveRootRedirect(c.env);
  // 302：临时重定向，避免浏览器把「随机一言」的入口永久缓存成一个固定结果。
  return c.redirect(url.toString(), 302);
});

// 5. 业务路由。
app.route('/api/quotes', quotesRoutes);
app.route('/api/admin', adminRoutes);

// 6. 未匹配路由统一 404。
app.notFound((c) => {
  const { pathname } = new URL(c.req.url);
  return fail(404, `未找到接口：${c.req.method} ${pathname}`);
});

// 7. 顶层错误处理：统一 JSON 结构 + 非阻塞日志。
app.onError((err, c) => {
  const { status, message } = toErrorResponse(err);
  const line = `[quotify] ${c.req.method} ${c.req.url} -> ${status} ${message}`;

  try {
    c.executionCtx.waitUntil(Promise.resolve(console.error(line, err)));
  } catch {
    console.error(line, err);
  }

  return fail(status, message);
});

export default app;
