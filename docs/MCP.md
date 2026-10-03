# Claude Chat / MCP 接入

## 协议基准

实现以当前正式规范 **MCP 2026-07-28** 为准，使用官方 `@modelcontextprotocol/server` v2 的 `createMcpHandler` 和 Node 适配器；同时保留 2025-11-25 等旧版的无会话握手兼容。不是只更新版本字符串：新版支持 `server/discover`、逐请求 `_meta`、必需 HTTP 镜像头校验、`resultType` 和标准错误码。详细核对与规范来源见 [MCP-COMPLIANCE.md](MCP-COMPLIANCE.md)。

Supabase 当前未声明 CIMD 和 RFC 9207 的 `iss` 回调能力：它们是规范的 SHOULD 项；DCR 已被弃用但仍明确允许作兼容回退。不得宣称已支持 CIMD，也不为此另写 OAuth 服务器。

## 用户连接

1. 在 Claude 的连接器设置中添加 `https://taskboard-liubai.vercel.app/api/mcp`。
2. 在留白授权页用已有邮箱密码登录，核对客户端名称、ID 与返回地址，允许访问自己的整个看板。没有公开注册。
3. 启用连接器，在聊天中要求查询或管理任务。可选上传 `/liubai-taskboard-skill.zip`，或使用仓库 `skills/liubai-taskboard/`。Skill 只提供工作流，不包含凭据。
4. 看板设置 →「授权、回收站与审计」管理授权、30 天回收站和 90 天操作审计。撤销不影响网页登录，但立即阻止对应 OAuth 会话的看板 RPC。

支持其他符合 OAuth 2.1 + Streamable HTTP 的 MCP 客户端动态注册。客户端名称是自行声明的，不是认证标志。首次连接必须得到用户同意；Agent 没有永久清除回收站工具，数据库也拒绝 OAuth 身份直接调用清除 RPC。

## 部署顺序

生产部署需要 Supabase 管理权限及 Vercel 项目权限。先迁移数据库，再发布应用；不要把 secret/service-role key 提供给客户端。当前 MCP 服务完全使用调用者的用户 token，不需要 service-role key。

### 1. 数据库

按顺序执行 `supabase/migrations/001`–`007`。已有 `006` 部署只需要 `007_mcp_rate_limit.sql`，必须先于新版 MCP 函数发布。迁移不改写现有快照或 revision；网页旧版 CAS 写入也会进入统一的删除捕获和审计触发器。

先启用 Cron 扩展，`006` 会安排每小时清理到期数据：

```sql
create extension if not exists pg_cron with schema pg_catalog;
```

如果应用 `006` 时尚未启用扩展，启用后补执行：

```sql
select cron.schedule('liubai-agent-retention', '17 * * * *', 'select private.cleanup_agent_data()');
```

回收条目从删除起 30 天后即不可读取或恢复，Cron 每小时物理清理；审计保留 90 天；幂等回执保留 24 小时且只含对象 ID 和版本，不含正文。首次启用不会找回迁移前已经删除的数据。

自部署域名不同时，设置数据库中的准确 MCP 资源 URL：

```sql
update private.agent_config set resource_url = 'https://YOUR_DOMAIN/api/mcp' where singleton;
```

### 2. Supabase Auth

- Authentication → OAuth Server：启用 OAuth 2.1 Server（Beta）及 Dynamic Client Registration。
- Site URL：`https://taskboard-liubai.vercel.app`（自部署时替换）。Authorization Path：`/oauth/consent`。
- 使用非对称 JWT signing key（ES256 / RS256），不要直接撤销仍有用户使用的旧验证密钥。
- Authentication → Hooks → Custom Access Token：选择 PostgreSQL 函数 `public.taskboard_access_token_hook`。该函数仅为 OAuth 令牌增加 MCP audience，保留 `authenticated` audience 供 PostgREST 使用，不改变普通网页登录令牌。
- SDK、数据库和服务器均核对 OAuth 会话与用户归属；直接 RPC 也检查会话及 consent 是否已撤销。不是仅靠 JWT 尚未过期就放行。

### 3. Vercel / Node 24

保留已有 `VITE_SUPABASE_URL` 和 `VITE_SUPABASE_PUBLISHABLE_KEY`。新增仅服务端可读的变量：

```dotenv
TASKBOARD_MCP_URL=https://taskboard-liubai.vercel.app/api/mcp
TASKBOARD_MCP_SECRET=<至少32字符的高强度随机值>
```

`TASKBOARD_MCP_SECRET` 用于签名短期读票，不是提供给用户的个人 API Key。不得加 `VITE_` 前缀。生成后存入托管平台的 Secret 环境变量，不提交 Git：

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

如需要来自其他浏览器域名的 MCP 客户端，配置 `TASKBOARD_MCP_ORIGINS` 为允许的完整 Origin 列表（逗号分隔）；不要使用通配符。Claude 等服务端连接无须该配置。

部署完整仓库而非只上传 `dist/`：`api/mcp.ts` 为 Node serverless 函数；`vercel.json` 包含授权页与资源发现重写。预览部署如需真实 OAuth，也需配置对应环境变量、Auth 站点地址和数据库资源 URL，不能把生产用户令牌用于无关预览域名。

```bash
pnpm install
pnpm skill:package
pnpm test:agent
pnpm build
```

### 4. 最小上线检查

```bash
curl -i https://YOUR_DOMAIN/api/mcp
curl -fsS https://YOUR_DOMAIN/.well-known/oauth-protected-resource/api/mcp
```

第一个应返回 401 和 `WWW-Authenticate` 资源发现信息；第二个返回准确 resource 与 Supabase issuer。随后实际连接 Claude，完成登录与授权，调用只读 `board_read`；撤销授权后再次调用必须失败。不要用真实用户的数据做删除演示。

## 工具与一致性

- `board_read` / `tasks_list`：只查询，不自动顺延。`board_read` 返回完整快照与 30 分钟有效、绑定用户和客户端的压缩签名读票。
- `board_apply`：最多 100 个领域操作一次 CAS 提交，可用 `$ref` 引用同批新对象；服务器只合并互不相关的实体修改，同实体或项目删除范围变化时整批拒绝。
- MCP 请求按授权用户 + OAuth 客户端在 Postgres 中原子限流，每分钟 120 次，超过返回 HTTP 429 与 `Retry-After`。它不依赖单个 Vercel 实例的内存，也不修改计划数据。
- 超时重试须保持相同 `requestId` 和参数。`readToken` 是包含私有快照的签名数据，不应展示或记录；不是独立授权凭据。
- `trash_list` / `audit_list` 分页读取。一次提交的删除集合为一个回收单位；恢复不会改写存活对象的关联或重新启动计时器，原项目缺失时可明确指定新项目与日期。
- 所有正式云端删除都由数据库触发器捕获，旧网页与直接调用现有 CAS RPC 无法绕过。LOCAL DEMO 仍是独立的本地演示，不提供云端授权与回收服务。
- 审计保存写入、同意／撤销及有身份请求的失败摘要，不记录成功查询、正文和凭据；匿名无效请求在 HTTP 边界拒绝，不写入用户审计。

## 快速验证范围

`pnpm test:agent` 覆盖领域操作、Postgres 权限／回收／限流、真实签名 JWT 的 HTTP 边界，以及新旧两代 MCP 的协议回归；`pnpm build` 同时做类型检查。没有新增测试框架，不执行慢速全量浏览器回归。

OAuth 管理依赖 Supabase Beta。迁移、Hook、签名算法及客户端联调必须都完成，不能把本地构建通过当作已经上线。
