# epigram · 隽语 API

> 中文名 **隽语**（即 `epigram` 的意译），是一个仿「一言（Hitokoto）」的引语 API 实现。
> 功能定位参考一言（随机返回一条或多条引语），但接口约定自成一套，**并非** Hitokoto 的兼容实现。

运行在 **Cloudflare Workers** 上的生产级引语 API：随机返回引语，并支持分类 / 标签筛选与关键词搜索。
数据源不是数据库，而是 **一个或多个 `data.json`**（可配置多个不同来源，随机抽取时合并成一个总池）；
运行时通过 **Cloudflare KV 懒加载缓存**，所有筛选 / 搜索 / 随机操作在 Worker 内存中完成。
不使用 D1，不使用任何 Node.js 专有 API。

- 运行时：Cloudflare Workers（V8 Isolates）
- 语言：TypeScript（`strict: true`，禁用 `any`）
- 框架：Hono
- 数据源：`DATA_SOURCES` 配置的多个来源，每个来源独立缓存、独立容错
- 缓存：Cloudflare KV（每个来源各缓存一份，TTL 300 秒）
- 限流：Cloudflare Rate Limiting Binding（公开 60 次/分钟/IP，管理 10 次/分钟/IP）
- 测试：Vitest + `@cloudflare/vitest-pool-workers`（测试真实运行在 Workers 运行时中）
- bundle：约 88 KiB（gzip 约 22 KiB），远低于 1 MB 上限

## 架构

```text
数据源 0..n（GitHub raw / 任意 HTTPS）
   │  data.json × n（每个来源格式相同）
   ▼
Cloudflare Worker (epigram-api)
   │  1. 进程内热缓存（60s，避免每请求重复解析）—— 命中即返回
   │  2. 并发查各来源的 KV 缓存 (epigram:data:v1:<来源序号>)
   │  3. 未命中 / 过期 → 并发回源
   │     （5s 超时 + 边缘缓存 60s；携带 If-None-Match，304 则复用旧数据并续期）
   │  4. 校验 JSON → 各来源回写自己的 KV (TTL 300s) + meta（含上游 ETag）
   │  5. 合并所有可用来源为一个总池（单个来源失败只跳过它，不拖垮整体）
   ▼
Cloudflare KV (epigram-cache)
   ▼
API 响应
```

> 热缓存以 isolate 为单位，只用于省掉「读 KV + 全量解析」，不承担一致性保证；
> 管理端 `/refresh` 会清掉当前 isolate 的副本。多 isolate 下数据最多陈旧一个热缓存 TTL（60s）。

## 目录结构

```text
epigram/
├── src/
│   ├── index.ts              # Worker 入口：安全头、CORS、根域重定向、健康检查、路由挂载、统一错误处理
│   ├── config.ts             # 常量、KV 键名、默认配置
│   ├── routes/
│   │   ├── quotes.ts         # 公开查询路由
│   │   └── admin.ts          # 管理路由
│   ├── data/
│   │   ├── loader.ts         # 多来源懒加载 / 合并 + 各来源独立 KV 与条件请求 + 数据校验
│   │   ├── store.ts          # 内存查询（filter / search / random / paginate）+ 派生索引记忆化
│   │   └── types.ts          # Quote / QuoteDataset 类型
│   ├── middleware/
│   │   ├── security.ts       # 通用安全响应头
│   │   ├── cors.ts           # CORS + OPTIONS 预检
│   │   ├── auth.ts           # 管理接口 Bearer 鉴权（恒定时间比较）
│   │   └── rateLimit.ts      # 速率限制
│   ├── utils/
│   │   ├── response.ts       # 统一响应格式 + 缓存头 / 304
│   │   └── error.ts          # 错误类型 + 参数校验
│   └── types/
│       └── env.ts            # 应用面向的 Env 绑定视图
├── tests/api.test.ts         # 集成 / 单元测试
├── .github/workflows/ci.yml  # CI：typecheck + test
├── data/data.json            # 示例数据集（推送到 epigram-data 仓库）
├── wrangler.toml
├── vitest.config.ts
├── tsconfig.json
└── package.json
```

## 命名约定

项目只用两个词，各司其职，避免同一概念出现多种叫法：

| 层 | 用词 | 示例 |
|:---|:---|:---|
| 公开契约 + 数据模型 | `quote` | `GET /api/quotes`、数据集字段 `quotes`、类型 `Quote` / `QuoteDataset` |
| 项目 / 品牌标识 | `epigram` | 包名 `epigram-api`、KV 键前缀 `epigram:`、`service: "epigram"` |

公开接口、数据集字段与代码类型统一使用通用的 `quote`：

- **语义准确**：本 API 收录的是「有出处、有作者的引语」——诗词、骈文、戏剧台词、箴言、讲义摘句，
  正是 `quote` / `quotation` 的范畴；相比之下 `epigram`（多指机智、带讽刺的短句）语义偏窄。
- **契约友好**：路径与数据集字段是长期对外契约且最难变更，通用词对使用者更友好，
  也是这类 API 的通行叫法。

`epigram` 仅作为项目品牌保留在包名、KV 键前缀与服务标识中，不再出现在对外契约里。

> 中文名「**隽语**」是 `epigram` 的意译，仅用于对外称呼与文档表述，不参与任何标识符命名。

## API 文档

所有接口（含错误）统一返回：

```json
{ "status": 200, "message": "ok.", "data": {}, "ts": 1581759895072 }
```

状态码约定：`200` 成功 / `400` 参数错误 / `401` 未授权 / `404` 未找到 / `429` 限流 / `500` 服务器错误。
所有响应都带 `Access-Control-Allow-Origin: *`（含错误响应），以及安全头
`X-Content-Type-Options: nosniff` 与 `Referrer-Policy: no-referrer`。
路径末尾的斜杠会被忽略：`/api/quotes` 与 `/api/quotes/` 等价（Hono 以 `strict: false` 启动）。

### `GET /` — 根域自动重定向

直接访问根域（例如 `https://epigram-api.<your-subdomain>.workers.dev/`）会 **302** 跳转到
`/api/quotes/`，避免用户看到裸 404。跳转只改写路径、**保留原始查询串**，
因此 `/?limit=5&format=text` 等价于 `/api/quotes/?limit=5&format=text`。

- 目标可通过环境变量 `ROOT_REDIRECT` 配置（默认 `/api/quotes/`）。
- 出于安全考虑只接受站内绝对路径（以单个 `/` 开头），配置成外链等非法值会回退到默认值，避免开放重定向。
- `HEAD /` 与 `GET /` 行为一致（Hono 会按 GET 处理并剥离响应体）。

### `GET /api/quotes` — 随机一言

| 参数 | 类型 | 默认 | 说明 |
|:---|:---|:---|:---|
| `category` | string | 无 | 分类，多个用逗号分隔（OR），最多 50 个 |
| `tag` | string | 无 | 标签，多个用逗号分隔（OR），最多 50 个 |
| `limit` | number | `1` | 返回数量，1–20（超出上限收敛到 20） |
| `format` | string | `json` | `json` 或 `text` |

`data` 始终为数组。`format=text` 时直接返回纯文本 `content`（多条以换行分隔），
`Content-Type: text/plain; charset=utf-8`。
`category` / `tag` 的取值个数超过 50 个时返回 `400`。

### `GET /api/quotes/search` — 关键词搜索

| 参数 | 类型 | 默认 | 说明 |
|:---|:---|:---|:---|
| `q` | string | **必填** | 关键词，最少 1 个字符 |
| `category` | string | 无 | 分类过滤，最多 50 个 |
| `tag` | string | 无 | 标签过滤，最多 50 个 |
| `limit` | number | `10` | 1–50 |
| `offset` | number | `0` | 偏移量，≥ 0 |

在 `content` / `author` / `source` 中做**大小写不敏感**的子串匹配。
`category` 与 `tag` 之间是 **AND**，同一参数内多个值是 **OR**。

### `GET /api/quotes/categories` / `GET /api/quotes/tags`

返回去重、按拼音排序的字符串数组。

结果在同一数据集内稳定，因此响应带 `Cache-Control: public, max-age=3600` 与 `ETag`；
客户端带 `If-None-Match` 再次请求时返回 **304**（无正文），并同样带 CORS 与安全头。

### `GET /api/health` — 健康检查

只读缓存状态（优先命中热缓存，不触发回源）。`data.sources` 表示「已缓存来源数 / 配置来源总数」。

```json
{
  "status": 200,
  "message": "ok.",
  "data": { "service": "epigram", "environment": "production", "cached": true, "cache_loaded_at": 1759000000000, "total": 1204, "sources": { "loaded": 2, "total": 2 } },
  "ts": 1759000000123
}
```

### `POST /api/admin/refresh` — 强制刷新缓存（需鉴权）

对**每个来源**分别「重新拉取 → 校验通过后覆盖自己的 KV」（`put` 会重置值与 TTL）。**不会**先删键：
这样上游数据非法时该来源的缓存仍保留上一份合法数据，不会出现空缓存窗口。

单个来源失败不影响其它来源：其结果记录在 `failures` 里，服务照常使用其余来源；只有**全部来源都失败**才返回 `500`。

若带上一次记录的上游 `ETag` 请求，上游返回 **304** 时直接复用缓存数据并仅续期 KV，
不重新下载与解析正文；此时 `total` 仍与当前数据集一致。

```json
{ "status": 200, "message": "ok.", "data": { "refreshed": true, "total": 1204, "loaded_at": 1759000000000, "sources": [{ "index": 0, "url": "https://.../a.json", "total": 600, "loaded_at": 1759000000000, "cached": false }], "failures": [] }, "ts": 1759000000123 }
```

### `GET /api/admin/stats` — 数据统计（需鉴权）

返回 `{ total, categories, tags, version, updated_at, cached, cache_loaded_at, sources, failures }`。
其中 `version` / `updated_at` 是各来源的**聚合值**（取较大者），按来源的明细在 `sources` 与 `failures` 中。

鉴权方式：请求头 `Authorization: Bearer <ADMIN_TOKEN>`，Token 采用恒定时间比较。

## 数据仓库格式

数据集通常放在独立仓库 **`epigram-data`** 的 `main` 分支根目录 `data.json`。
可以配置**多个来源**（见「环境变量」的 `DATA_SOURCES`）——每个来源都使用下面这同一种格式，
运行时会被合并成一个总池：随机抽取覆盖全部来源，搜索 / 分类 / 标签也跨来源聚合。

```json
{
  "version": 1,
  "updated_at": "2026-09-26T12:00:00Z",
  "quotes": [
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
- `quotes` 必须是数组。
- 每条记录必须含非空字符串 `id` 与 `content`。
- `source` / `author` / `category` 可选，若存在必须是字符串；`tags` 可选，若存在必须是字符串数组。
- 非法数据直接返回 `500` 并记录日志，**不会**静默丢弃，也**不会**写入 KV。

本仓库 `data/data.json` 是一份可直接推送的示例数据集（10 条）。

KV 键设计：

| 键 | 值 | 说明 |
|:---|:---|:---|
| `epigram:data:v1:<来源序号>` | JSON 字符串 | 该来源的数据集（序号即 `DATA_SOURCES` 数组下标） |
| `epigram:meta:v1:<来源序号>` | JSON 字符串 | `{ loaded_at, source_url, etag? }`（`etag` 为上游 ETag，用于条件请求） |

## 环境变量

| 名称 | 类型 | 默认 | 说明 |
|:---|:---|:---|:---|
| `DATA_SOURCES` | var | 作者维护的 `epigram-data` 仓库 | 数据集来源列表（**JSON 字符串数组**，可多个；Fork 后请换成自己的，见「自建部署教程」） |
| `DATA_TTL` | var | `300` | KV 缓存 TTL（秒） |
| `ROOT_REDIRECT` | var | `/api/quotes/` | 根路径 302 重定向目标（仅接受站内绝对路径） |
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

# 需要真实数据时，把 DATA_SOURCES 指向一个可访问的地址，例如本地静态文件服务
node -e "const http=require('http'),fs=require('fs');http.createServer((q,s)=>{s.setHeader('content-type','application/json');s.end(fs.readFileSync('data/data.json'))}).listen(8788)"
npx wrangler dev --var 'DATA_SOURCES:["http://127.0.0.1:8788/data.json"]'
```

其它脚本：

```bash
npm test           # vitest run，在 Workers 运行时中执行集成测试
npm run typecheck  # tsc --noEmit
npm run cf-typegen # 修改 wrangler.toml 后重新生成 worker-configuration.d.ts
```

> `worker-configuration.d.ts` 由 `wrangler types` 生成（包含 `KVNamespace`、`RateLimit` 等运行时类型
> 以及全局 `Env`），修改 `wrangler.toml` 后需要重新生成。

## 自建部署教程（Fork 并托管自己的隽语 API）

面向「Fork 一份、换成自己的数据集、部署到自己的 Cloudflare 账号」的场景。
下面每一步都对应 `wrangler.toml` 里的注释，照着改即可。

### 0. 前置条件

- 一个 Cloudflare 账号（Workers Free 计划即可）
- 已把本仓库 Fork 到你的 GitHub 账号并 clone 到本地
- 本地执行过 `npm install`（Wrangler 是项目依赖，统一用 `npx wrangler` 调用）
- 已执行 `npx wrangler login` 完成授权

### 1. 准备你自己的数据集

新建一个 GitHub 仓库（例如 `my-quotes-data`），在根目录放 `data.json`，
格式见上文「数据仓库格式」——**根字段必须是 `quotes`**，每条记录至少要有非空的 `id` 与 `content`。
可以直接复制本仓库的 [data/data.json](data/data.json) 当模板，把条目替换成你自己的。

想用**多个来源**（例如「古诗词」「名人名言」各一个仓库）就重复这一步：
每个来源都是一份格式相同的 `data.json`，运行时会被合并成一个总池。

> `wrangler.toml` 中 `DATA_SOURCES` 的注释写着「任意公网可访问、且返回符合本项目数据格式的 JSON 的链接都可以」——
> 也就是说数据集**不一定要放在 GitHub**，你自己的静态服务器 / 对象存储同样可行，只要 URL 公网可读。

### 2. 把 `DATA_SOURCES` 指向你自己的数据集

```toml
[vars]
# 单个来源
DATA_SOURCES = '["https://raw.githubusercontent.com/<你的用户名>/my-quotes-data/main/data.json"]'

# 多个来源：数组顺序即来源序号，对应 KV 键 epigram:data:v1:<序号>
DATA_SOURCES = '["https://raw.githubusercontent.com/<你的用户名>/poems/main/data.json", "https://raw.githubusercontent.com/<你的用户名>/sayings/main/data.json"]'
```

> 对应注释：「默认指向作者维护的 epigram-data 仓库；Fork 后请替换成你自己的仓库地址，**否则你改不动数据**」。
> 保持默认值时，你的实例会一直读取作者的数据集，自己改数据不会有任何效果。
>
> ⚠️ `DATA_SOURCES` 必须是**合法的 JSON 字符串数组**；写错（例如不是数组、不是合法 JSON）时接口会直接报 `500`
> 并给出提示，而不会静默回退到默认来源——避免「配置写错了却毫无察觉」。

### 3. 创建你自己的 KV 命名空间

```bash
npx wrangler kv namespace create epigram-cache
```

命令会输出一个 `id`，用它覆盖 `wrangler.toml` 里 `[[kv_namespaces]].id`：

```toml
[[kv_namespaces]]
binding = "CACHE"
id = "<上一步输出的 id>"
```

> 对应注释：「下面的 id 属于本项目作者，Fork 后你无权访问，必须换成自己的」。
> KV 命名空间 id 本身是公开信息、不是密钥，但它绑定在作者账号下，你无法读写。

### 4. 设置管理接口 Token

`wrangler.toml` 里的 `ADMIN_TOKEN = "dev-secret-token"` 只是本地开发默认值，生产环境必须用 secret 覆盖：

```bash
npx wrangler secret put ADMIN_TOKEN
```

> 对应注释：「本地开发默认值；生产环境请用 `wrangler secret put ADMIN_TOKEN` 覆盖」。
> secret 优先级高于同名 var，且不会进入仓库。

### 5. 按需调整其它变量

| 变量 | 是否必须改 | 说明 |
|:---|:---|:---|
| `ROOT_REDIRECT` | 否 | 访问根域时的 302 目标，默认 `/api/quotes/`；只接受站内绝对路径 |
| `DATA_TTL` | 否 | KV 缓存 TTL（秒），默认 `300` |
| `ENVIRONMENT` | 否 | 环境标识，会出现在 `/api/health` 响应中 |
| `[[ratelimits]].namespace_id` | 建议 | 见下方说明 |

> 对应注释：「访问根域（`/`）时 302 跳转的目标（站内绝对路径），默认指向公开随机一言接口」。
>
> ⚠️ **限流绑定的 `namespace_id`** 是「账号内唯一」的标识：同一账号下若已有 Worker 用了 `1001` / `1002`，
> 两者会共享同一份限流计数。若遇到意料之外的 429，把它们改成不冲突的数字。

### 6. 部署

```bash
npx wrangler deploy
```

部署完成后终端会输出形如 `https://epigram-api.<你的子域>.workers.dev` 的访问地址。

### 7. 首次预热与验证

```bash
BASE=https://epigram-api.<你的子域>.workers.dev

curl "$BASE/api/health"      # 首次：cached=false、total=0（KV 还是空的）
curl "$BASE/api/quotes"      # 触发首次回源，返回你自己的数据
curl "$BASE/api/health"      # 再次：cached=true、total 与你的数据集条数一致

# 主动刷新缓存（需要第 4 步设置的 Token）
curl -X POST -H "Authorization: Bearer <你的 ADMIN_TOKEN>" "$BASE/api/admin/refresh"
```

完整验收项见文末「生产验证清单」。

### 8. 以后如何更新数据集

只需修改你数据仓库里的 `data.json` 并提交。Worker 会在 KV 过期（`DATA_TTL`，默认 300 秒）后
自动拉到新数据；想立即生效，调一次 `POST /api/admin/refresh`。

### 常见问题

- **访问根域 404？** 根域会自动 302 到 `/api/quotes/`；若你改过 `ROOT_REDIRECT`，确认它是站内绝对路径（以单个 `/` 开头）。
- **`/api/quotes` 一直返回 500？** 说明**所有来源**都加载失败了（单个来源失败只会被跳过）。常见原因是数据集格式不合规：
  根字段不是 `quotes`，或某条记录缺 `id` / `content`。校验不通过时不会写入缓存，日志里会指出是哪个来源、第几条、哪个字段。
- **某个来源挂了会有影响吗？** 不会：该来源被跳过，其余来源照常提供服务；`/api/admin/stats` 的 `failures` 里能看到具体原因和 URL。
- **管理接口返回 401？** 检查请求头为 `Authorization: Bearer <token>`，且 token 与 `ADMIN_TOKEN` 一致（secret 优先于 var）。
- **改了 `wrangler.toml` 后类型报错？** 执行 `npm run cf-typegen` 重新生成 `worker-configuration.d.ts`。

## curl 调用示例清单

```bash
BASE=https://epigram-api.<your-subdomain>.workers.dev

# 根域自动重定向（302 → /api/quotes/）
curl -i "$BASE/"

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

1. `npm test` —— 37 个用例全部通过。
2. `npm run typecheck` —— 无类型错误。
3. `curl -i "$BASE/"` —— 返回 `302` 且 `Location` 指向 `/api/quotes/`。
4. `curl "$BASE/api/health"` —— `status=200`、`data.service="epigram"`，且 `data.sources` 显示「已缓存 / 配置总数」。
5. 首次 `curl "$BASE/api/quotes"` —— 返回数据且 KV 被写入；再次请求 `data.cached` 为 `true`。
6. `curl -i -X OPTIONS "$BASE/api/quotes"` —— 返回 `Access-Control-Allow-Origin: *`。
7. `curl -i "$BASE/api/health"` —— 含 `X-Content-Type-Options: nosniff` 与 `Referrer-Policy: no-referrer`。
8. `curl -i "$BASE/api/quotes/categories"` —— 含 `Cache-Control: public, max-age=3600` 与 `ETag`；
   带上该 `ETag` 的 `If-None-Match` 再次请求 —— 返回 `304`。
9. `curl -X POST "$BASE/api/admin/refresh"`（无 Token）—— 返回 `401`。
10. `curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" "$BASE/api/admin/refresh"` —— 返回 `200` 且 `total` 与数据仓库条数一致。
11. 把 `data.json` 中某条记录的 `content` 置空并提交 —— 管理刷新接口应返回 `500`，且 KV 中仍是上一份合法数据。
12. 配好两个 `DATA_SOURCES` 后 `curl "$BASE/api/admin/stats"` —— `sources` 有两项，`total` 等于两个数据集条数之和。
