# epigram · 一言 API

运行在 **Cloudflare Workers** 上的生产级一言（quotes / epigram）API。
数据源不是数据库，而是 **GitHub 仓库中的 `data.json`**；运行时通过 **Cloudflare KV 懒加载缓存**，
所有筛选 / 搜索 / 随机操作在 Worker 内存中完成。不使用 D1，不使用任何 Node.js 专有 API。

- 运行时：Cloudflare Workers（V8 Isolates）
- 语言：TypeScript（`strict: true`，禁用 `any`）
- 框架：Hono
- 缓存：Cloudflare KV（整份 `data.json` 作为一个值缓存，TTL 300 秒）
- 限流：Cloudflare Rate Limiting Binding（公开 60 次/分钟/IP，管理 10 次/分钟/IP）
- 测试：Vitest + `@cloudflare/vitest-pool-workers`（测试真实运行在 Workers 运行时中）
- bundle：约 78 KiB（gzip 约 20 KiB），远低于 1 MB 上限

## 架构

```text
GitHub 仓库 (epigram-data)
   │  data.json
   ▼
Cloudflare Worker (epigram-api)
   │  1. 查 KV 缓存 (epigram:data:v1)
   │  2. 未命中 / 过期 → fetch raw.githubusercontent.com（5s 超时 + 边缘缓存）
   │  3. 校验 JSON → 回写 KV (TTL 300s) + meta
   ▼
Cloudflare KV (epigram-cache)
   ▼
API 响应
```

## 目录结构

```text
epigram/
├── src/
│   ├── index.ts              # Worker 入口：CORS、健康检查、路由挂载、统一错误处理
│   ├── config.ts             # 常量、KV 键名、默认配置
│   ├── routes/
│   │   ├── quotes.ts         # 公开查询路由
│   │   └── admin.ts          # 管理路由
│   ├── data/
│   │   ├── loader.ts         # KV / GitHub 懒加载 + 数据校验
│   │   ├── store.ts          # 内存查询（filter / search / random / paginate）
│   │   └── types.ts          # Epigram / EpigramDataset 类型
│   ├── middleware/
│   │   ├── cors.ts           # CORS + OPTIONS 预检
│   │   ├── auth.ts           # 管理接口 Bearer 鉴权
│   │   └── rateLimit.ts      # 速率限制
│   ├── utils/
│   │   ├── response.ts       # 统一响应格式
│   │   └── error.ts          # 错误类型 + 参数校验
│   └── types/
│       └── env.ts            # Env 绑定类型
├── tests/api.test.ts         # 集成测试
├── data/data.json            # 示例数据集（推送到 epigram-data 仓库）
├── wrangler.toml
├── vitest.config.ts
├── tsconfig.json
└── package.json
```

## API 文档

所有接口（含错误）统一返回：

```json
{ "status": 200, "message": "ok.", "data": {}, "ts": 1581759895072 }
```

状态码约定：`200` 成功 / `400` 参数错误 / `401` 未授权 / `404` 未找到 / `429` 限流 / `500` 服务器错误。
所有响应都带 `Access-Control-Allow-Origin: *`。
路径末尾的斜杠会被忽略：`/api/quotes` 与 `/api/quotes/` 等价（Hono 以 `strict: false` 启动）。

### `GET /api/quotes` — 随机一言

| 参数 | 类型 | 默认 | 说明 |
|:---|:---|:---|:---|
| `category` | string | 无 | 分类，多个用逗号分隔（OR） |
| `tag` | string | 无 | 标签，多个用逗号分隔（OR） |
| `limit` | number | `1` | 返回数量，1–20（超出上限收敛到 20） |
| `format` | string | `json` | `json` 或 `text` |

`data` 始终为数组。`format=text` 时直接返回纯文本 `content`（多条以换行分隔），
`Content-Type: text/plain; charset=utf-8`。

### `GET /api/quotes/search` — 关键词搜索

| 参数 | 类型 | 默认 | 说明 |
|:---|:---|:---|:---|
| `q` | string | **必填** | 关键词，最少 1 个字符 |
| `category` | string | 无 | 分类过滤 |
| `tag` | string | 无 | 标签过滤 |
| `limit` | number | `10` | 1–50 |
| `offset` | number | `0` | 偏移量，≥ 0 |

在 `content` / `author` / `source` 中做**大小写不敏感**的子串匹配。
`category` 与 `tag` 之间是 **AND**，同一参数内多个值是 **OR**。

### `GET /api/quotes/categories` / `GET /api/quotes/tags`

返回去重、按拼音排序的字符串数组。

### `GET /api/health` — 健康检查

只读缓存状态，不触发回源。

```json
{
  "status": 200,
  "message": "ok.",
  "data": { "service": "epigram", "cached": true, "cache_loaded_at": 1759000000000, "total": 1204 },
  "ts": 1759000000123
}
```

### `POST /api/admin/refresh` — 强制刷新缓存（需鉴权）

重新拉取 GitHub → 校验通过后覆盖 KV（`put` 会重置值与 TTL）。**不会**先删键：
这样上游数据非法时缓存仍保留上一份合法数据，不会出现空缓存窗口。

```json
{ "status": 200, "message": "ok.", "data": { "refreshed": true, "total": 1204, "loaded_at": 1759000000000, "source_url": "https://raw.githubusercontent.com/..." }, "ts": 1759000000123 }
```

### `GET /api/admin/stats` — 数据统计（需鉴权）

返回 `{ total, categories, tags, version, updated_at, cached, cache_loaded_at }`。

鉴权方式：请求头 `Authorization: Bearer <ADMIN_TOKEN>`。

## 数据仓库格式

数据集放在独立仓库 **`epigram-data`** 的 `main` 分支根目录 `data.json`：

```json
{
  "version": 1,
  "updated_at": "2026-09-26T12:00:00Z",
  "epigrams": [
    {
      "id": "e1f3a2",
      "content": "人生如逆旅，我亦是行人。",
      "source": "临江仙·送钱穆父",
      "author": "苏轼",
      "category": "文学",
      "tags": ["古诗", "人生"]
    }
  ]
}
```

校验规则（`src/data/loader.ts`）：

- `version` 必须是数字。
- `epigrams` 必须是数组。
- 每条记录必须含非空字符串 `id` 与 `content`。
- `source` / `author` / `category` / `tags` 可选。
- 非法数据直接返回 `500` 并记录日志，**不会**静默丢弃，也**不会**写入 KV。

本仓库 `data/data.json` 是一份可直接推送的示例数据集（10 条）。

KV 键设计：

| 键 | 值 | 说明 |
|:---|:---|:---|
| `epigram:data:v1` | JSON 字符串 | 完整数据集 |
| `epigram:meta:v1` | JSON 字符串 | `{ loaded_at, source_url }` |

数据结构升级时把版本后缀换成 `v2`，避免旧缓存污染。

## 环境变量

| 名称 | 类型 | 默认 | 说明 |
|:---|:---|:---|:---|
| `DATA_URL` | var | `https://raw.githubusercontent.com/<owner>/epigram-data/main/data.json` | 数据集地址 |
| `DATA_TTL` | var | `300` | KV 缓存 TTL（秒） |
| `ENVIRONMENT` | var | `production` | 环境标识 |
| `ADMIN_TOKEN` | **secret** | 本地开发默认 `dev-secret-token` | 管理接口 Token |
| `CACHE` | KV binding | — | 缓存命名空间 |
| `PUBLIC_RATE_LIMITER` | ratelimit binding | 60 / 60s | 公开接口限流 |
| `ADMIN_RATE_LIMITER` | ratelimit binding | 10 / 60s | 管理接口限流 |

生产环境必须执行 `npx wrangler secret put ADMIN_TOKEN`，secret 会覆盖 `wrangler.toml` 中的同名 var。

> 关于 `compatibility_date`：规范要求 `2026-09-01`，但本地测试链路
> （`@cloudflare/vitest-pool-workers` 内置的 miniflare / workerd）当前最高支持 `2026-08-22`，
> 因此这里取 `2026-08-01`，保证 `dev` / `test` / `deploy` 三端行为一致。

## 本地开发

```bash
npm install

# 启动本地开发服务器（默认 http://127.0.0.1:8787）
npm run dev

# 需要真实数据时，把 DATA_URL 指向一个可访问的地址，例如本地静态文件服务
node -e "const http=require('http'),fs=require('fs');http.createServer((q,s)=>{s.setHeader('content-type','application/json');s.end(fs.readFileSync('data/data.json'))}).listen(8788)"
npx wrangler dev --var DATA_URL:http://127.0.0.1:8788/data.json
```

其它脚本：

```bash
npm test           # vitest run，在 Workers 运行时中执行集成测试
npm run typecheck  # tsc --noEmit
npm run cf-typegen # 修改 wrangler.toml 后重新生成 worker-configuration.d.ts
```

> `worker-configuration.d.ts` 由 `wrangler types` 生成（包含 `KVNamespace`、`RateLimit` 等运行时类型
> 以及全局 `Env`），修改 `wrangler.toml` 后需要重新生成。

## 部署

```bash
# 1. 创建 KV 命名空间 epigram-cache，把输出的 id 填入 wrangler.toml
npx wrangler kv namespace create epigram-cache

# 2. 设置管理 Token（生产环境）
npx wrangler secret put ADMIN_TOKEN

# 3. 把 [vars].DATA_URL 中的 <owner> 换成真实 GitHub 用户名

# 4. 部署
npx wrangler deploy
```

## curl 调用示例清单

```bash
BASE=https://epigram-api.<your-subdomain>.workers.dev

# 健康检查
curl "$BASE/api/health"

# 随机一条
curl "$BASE/api/quotes"

# 随机 5 条
curl "$BASE/api/quotes?limit=5"

# 纯文本输出（可直接接入终端脚本）
curl "$BASE/api/quotes?format=text"

# 按分类筛选
curl "$BASE/api/quotes?category=文学"

# 按标签筛选（OR）
curl --get "$BASE/api/quotes" --data-urlencode "tag=古诗,人生"

# 分类 + 标签组合（AND）
curl --get "$BASE/api/quotes" --data-urlencode "category=文学" --data-urlencode "tag=人生" --data-urlencode "limit=3"

# 关键词搜索
curl --get "$BASE/api/quotes/search" --data-urlencode "q=人生"

# 搜索 + 分页
curl --get "$BASE/api/quotes/search" --data-urlencode "q=人" --data-urlencode "limit=5" --data-urlencode "offset=5"

# 分类 / 标签枚举
curl "$BASE/api/quotes/categories"
curl "$BASE/api/quotes/tags"

# 参数错误示例（400）
curl "$BASE/api/quotes/search"

# CORS 预检
curl -i -X OPTIONS "$BASE/api/quotes"

# 管理接口：强制刷新缓存
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" "$BASE/api/admin/refresh"

# 管理接口：数据统计
curl -H "Authorization: Bearer $ADMIN_TOKEN" "$BASE/api/admin/stats"
```

## 生产验证清单

1. `npm test` —— 17 个用例全部通过。
2. `npm run typecheck` —— 无类型错误。
3. `curl "$BASE/api/health"` —— `status=200` 且 `data.service="epigram"`。
4. 首次 `curl "$BASE/api/quotes"` —— 返回数据且 KV 被写入；再次请求 `data.cached` 为 `true`。
5. `curl -i -X OPTIONS "$BASE/api/quotes"` —— 返回 `Access-Control-Allow-Origin: *`。
6. `curl -X POST "$BASE/api/admin/refresh"`（无 Token）—— 返回 `401`。
7. `curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" "$BASE/api/admin/refresh"` —— 返回 `200` 且 `total` 与数据仓库条数一致。
8. 把 `data.json` 中某条记录的 `content` 置空并提交 —— 管理刷新接口应返回 `500`，且 KV 中仍是上一份合法数据。
