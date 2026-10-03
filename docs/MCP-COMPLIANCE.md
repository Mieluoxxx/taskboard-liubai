# MCP 2026-07-28 符合性核对

## 基准与结论

本次核对针对官方标记为 **Current** 的正式规范 `2026-07-28`，不是 draft，也不是 npm 包版本号。原实现使用 SDK 1.31.0，只支持至 `2025-11-25`，不能据此声称符合最新规范。

现改用官方 `@modelcontextprotocol/server` 2.3.x 与 `@modelcontextprotocol/node` 2.1.x，通过 `createMcpHandler` 明确启用现代协议，保留 `legacy: stateless` 兼容旧客户端。仅升级 SDK 或手动更改版本字符串都不足以完成迁移。

来源：[官方版本说明](https://modelcontextprotocol.io/docs/learn/versioning)、[SDK 迁移指南](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28)。

## 已修复或确认的关键项

| 项目 | 要求／原问题 | 当前实现与验证 |
| --- | --- | --- |
| 逐请求协议 | 新版不使用 initialize 握手建立协议上下文 | 官方 handler 读取每次请求的 `_meta`，不推断连接身份；旧版另走官方兼容分支。 |
| 服务发现 | `server/discover` 为 MUST，旧实现缺失 | 返回 2026-07-28、工具能力与 serverInfo；客户端可直接调用工具，无需先发现。 |
| 元数据 | protocolVersion、clientCapabilities 必需，clientInfo 为 SHOULD | 缺少必需项返回 HTTP 400 / -32602；省略 clientInfo 仍能成功。权限不取自自报 clientInfo。 |
| 镜像请求头 | MCP-Protocol-Version、Mcp-Method、按方法需要的 Mcp-Name 必需且应与正文一致 | SDK 校验并解码 Base64 sentinel；缺少、畸形或不匹配返回 HTTP 400 / -32020，未执行业务 RPC。 |
| 版本与方法错误 | 不支持版本 -32022；未知 RPC 方法 HTTP 404 / -32601 | 验证 supported/requested 信息与 HTTP 状态。没有自定义旧式 -32000 新错误码。 |
| 成功结果 | 新版所有结果有 resultType | SDK wire codec 输出 complete 与 serverInfo；旧版维持原协议形状。 |
| 工具定义 | tools 能力、确定性列表、JSON Schema 对象、输入校验 | 同一批 5 个工具由官方 SDK 服务两代协议；使用 Zod 4 标准 schema，输出默认 2020-12。 |
| 工具错误 | 可修正的输入／业务错误应为 isError，协议结构错误为 JSON-RPC error | 验证越界参数返回 complete/isError，协议错误不会调用业务代码。 |
| HTTP 传输 | POST 单消息；通知被接受时 202 无正文；解析与方法状态规范化 | 删除自写解析分支，交给官方 handler 与 Node 适配器；支持 Vercel 预解析 body，保留 2 MB 限制。 |
| 跨域互操作 | 原 CORS 不允许新头，浏览器读不到挑战，发现文档无 CORS | 允许 Mcp-Method/Mcp-Name，暴露 WWW-Authenticate 与 Retry-After；公共资源元数据允许跨域 GET/HEAD。 |
| 鉴权 | 每请求 Bearer，验证签名、过期、issuer、目标 audience，无效令牌 401 | 使用公开 JWKS 在入口本地验证签名和标准 JWT 声明，数据库再检查 session/consent；无效令牌携带 invalid_token challenge；上游暂不可用返回 503。 |
| 不转发访问令牌 | 授权安全章节明确 MUST NOT 把 MCP 入站 token 传给上游 API；原实现使用同一 Bearer 调用 Supabase HTTP RPC | 移除该路径。JOSE 本地验签；独立最小权限 PostgreSQL 角色调用固定分派函数，只携带已验证的最少主体上下文，不携带原 token。测试拒绝任何上游 HTTP token 传递，验证角色不能读表、直接调用普通 RPC 或永久清除。 |
| 调用限流 | 工具安全章节要求 MUST rate limit；原实现仅限制输入大小和失败日志 | 007 迁移按用户 + OAuth 客户端原子计数，每分钟 120 次 MCP 请求，跨 serverless 实例有效；超额 429 + Retry-After。 |
| 授权页面安全 | 防止点击劫持，避免 URL 中的授权信息经 Referer 泄露 | 托管层配置 frame-ancestors none、X-Frame-Options DENY、Referrer-Policy no-referrer。 |
| 显式应用状态 | 新版不能依赖协议会话关联业务调用 | readToken 是绑定用户／客户端、限时签名的工具参数，不是协议会话，也不是独立访问凭据。 |

规范来源：

- [版本协商与兼容](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning)
- [HTTP 传输与请求头](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)
- [基础消息与元数据](https://modelcontextprotocol.io/specification/2026-07-28/basic/index)
- [服务发现](https://modelcontextprotocol.io/specification/2026-07-28/server/discover)
- [工具、错误与安全要求](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)
- [授权](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
- [授权安全要求：Access Token Privilege Restriction](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations)
- [安全最佳实践](https://modelcontextprotocol.io/specification/2026-07-28/basic/security_best_practices)

## 不能夸大为全部覆盖的项目

- **CIMD**：规范为 SHOULD。实测 Supabase 元数据未声明 `client_id_metadata_document_supported`，仍提供 DCR endpoint。DCR 已被弃用，但当前规范仍以 MAY 保留，明确用于兼容不支持 CIMD 的授权服务器。本次不另外实现高风险 OAuth 代理；后续随授权服务升级。
- **RFC 9207 iss 回调**：授权服务器 inclusion 是 SHOULD；当前 Supabase 未声明 `authorization_response_iss_parameter_supported`。不伪造能力声明。客户端应按规范处理未声明／缺失情况，并对出现的 iss 做严格比较。
- **可选功能**：不为了版本升级新增 prompts、resources、sampling、MCP Apps 或 Tasks。业务当前无需这些功能，也未把它们伪装成已实现能力。
- **输出 schema**：工具 outputSchema 为可选，本次没有为了合规伪造宽松输出 schema；保留文本 JSON 与 structuredContent 一致的结果。
- 这是针对该服务的规范核对与回归证据，不是 MCP 官方认证，也不声称已经测试所有客户端／所有可选扩展。

来源：[客户端注册与 DCR 弃用说明](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration)。

## 验证与发布要求

`pnpm test:agent` 运行 6 组集中检查，包括新版正反例、旧版兼容、真实测试密钥签发 JWT 的 HTTP 边界、跨域发现、限流与撤销；Postgres 测试验证第 121 次请求拒绝、窗口恢复、数据库通道 ACL、主体上下文不串线、过期与撤销；HTTP 测试只允许公开 JWKS 网络请求，断言数据库参数没有原 MCP token。没有引入新测试框架。

上线前必须执行 007、008 迁移并配置专用数据库角色、issuer、连接 Secret 与可信 CA，再部署新函数。构建后应在生产上用临时授权验证 `server/discover`、新版 tools/list／只读调用、旧版 initialize／tools/list 和坏镜像头拒绝；验证不修改真实任务，临时授权和客户端随后撤销／清理。
