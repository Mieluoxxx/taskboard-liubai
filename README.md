# Liubai Taskboard

一个安静的个人双端规划工作区：长期目标、ISO 周计划、日计划和专注计时器保持四列横向模型。默认中文，可切换英文。

[MIT 许可](LICENSE)。

**线上地址**：https://taskboard-liubai.vercel.app （Vercel，静态前端 + Supabase 后端）

- 后端：Supabase Free 项目，数据库迁移见 `supabase/migrations/`（依次执行 `001`、`002`、`003`、`004`）
- 部署：Vercel 导入本仓库，环境变量 `VITE_SUPABASE_URL` 与 `VITE_SUPABASE_PUBLISHABLE_KEY`（两者都是浏览器可见的公开值，真正的访问控制由 RLS 与数据库 RPC 承担）
- 推送 `main` 即自动重新部署

## 字体

界面使用 **Maple Mono NF CN**（[subframe7536/maple-font](https://github.com/subframe7536/maple-font)，SIL OFL 1.1），本地自托管、不请求任何第三方 CDN。

完整字体包是 156 MB / 16 个字重，直接使用会让首屏无法接受，因此按用途切成四片、用 `unicode-range` 让浏览器只下载真正用到的部分：

| 分片 | 内容 | 体积（每字重） | 何时下载 |
|---|---|---|---|
| `core` | 拉丁、数字、标点、**界面自身的全部中文** | ~0.25 MB | **首屏预加载**（两个字重共约 0.5 MB） |
| `common` | 字频前 3000 的中文（覆盖约 99% 正文） | ~0.6 MB | 出现中文内容时 |
| `tail` | 其余生僻字、兼容表意等兜底 | ~4.8 MB | 真的用到时 |
| `nerd` | Nerd Font 图标（U+E000–F8FF） | ~0.5 MB | 使用图标时 |

- 关键部分在 `src/fonts.css`（仅 core，压缩后约 3 KB，阻塞渲染必须小）；其余在 `public/fonts/maple-mono-cn/fonts-lazy.css`，由 `index.html` 以 `media="print"` 技巧异步加载。
- 四个分片码点互不重叠，因此无需关心声明顺序。
- `core` 里除了源码中的界面文案，还包含**运行时由 Intl 生成的日期与星期**（`2026年9月12日`、`周五`）；这类文字源码里没有字面量，容易漏，`scripts/build-fonts.py` 里显式列了出来。
- 因此应用外壳（登录页、空板、周期轨道、日期）全程只用 `core`：实测首次进入只需 core 两个字重（约 0.5 MB），不会为了界面装饰去下载 common。只有出现用户自己的中文内容时才加载 `common`（约 0.6 MB，之后一年不可变缓存）。
- 许可文本随字体分发：`public/fonts/LICENSE-maple-mono.txt`。
- 升级字体版本或调整分片：`python3 scripts/build-fonts.py`（脚本内含所需外部数据说明）。
- `vercel.json` 为 `/fonts/*` 与 `/assets/*` 设置一年不可变缓存（文件名带版本或内容哈希）。

## 本地运行

要求 Node 24 与 pnpm（本仓库用 pnpm 12 验证；lockfile 为 v9，可由较新的 pnpm 读取）。

```bash
pnpm install
cp .env.example .env.local
pnpm dev
```

执行检查：

```bash
pnpm typecheck
pnpm test
pnpm build
```

## 界面语言

界面文案与运行时提示（保存失败、冲突、离线、计时器占用等）都随语言切换：提示以 code 在各层传递，只有 `src/i18n.ts` 与 `src/notices.ts` 持有两种语言的文本。`pnpm test` 会校验两种语言键位一致、提示不混用语言。

## 本地 Demo

未配置 Supabase 时，应用会显示设置页；点击明确的 **LOCAL DEMO** 才会进入演示模式。演示板保存在 `liubai-taskboard:demo-board:v1`，不会与真实账号混用，也不会上传。演示数据会锚定当前本地日期。

## Supabase 配置

1. 在 Supabase 项目中关闭 Auth 的新用户注册（Disable sign ups）；本应用不提供 signup、OAuth 或 reset UI。
2. 在 Auth 用户页用管理员方式创建任意数量的邮箱/密码账号；不要把密码写入仓库或 `.env`。创建 Auth 用户只提供登录身份，首次登录时应用会自动创建该用户自己的空看板。
3. 在 SQL Editor 中依次执行 `supabase/migrations/001_private_board.sql`、`002_independent_boards.sql`、`003_task_text_limits.sql`、`004_remove_task_history.sql`。已有项目只补执行尚未执行的迁移；不要重跑 `001` 或它顶部的旧 owner provisioning 注释。
   - `003` 把任务标题／备注上限从 300／2000 放宽到 450／3000，必须先执行，再发布新版前端；否则超过旧上限的文本会被云端拒绝。
   - `004` 停止要求与校验 `tasks[].history`。**同样必须先执行 `004`，再发布不写 `history` 的新版前端**，否则 `003` 的校验器会把每一个云保存都判为非法。
   - 迁移后仍停留在旧页面（未刷新）的标签页继续写带 `history` 的快照：由于 `004` 只放宽校验，这些写入会被接受；但它们读到新版前端存下的无 `history` 快照时会报校验失败。**草稿只存在页面内存里**（没有本地持久化），刷新前请先点恢复入口把失败保存的内容重新编辑或复制出来，否则刷新会丢弃它。
4. 只把 `VITE_SUPABASE_URL` 与 publishable key（旧项目可用 anon key）写入 `.env.local`，重启 Vite。每个账号只能访问自己的看板。
5. 手动密码重置请由项目管理员在 Supabase Auth 用户管理处完成；应用不会伪造不存在的 dashboard 功能。

免费计划项目可能因长期不活动暂停，恢复后首次请求可能较慢。Supabase 内置邮件发送能力仅适合有限开发用途，有速率/送达限制；本应用不依赖邮件重置流程。

## 部署

可将 `dist/` 部署到任意静态托管（例如 Vercel、Netlify 或自有 CDN）：

```bash
pnpm build
```

只在部署平台配置同名 `VITE_` 环境变量；它们是浏览器可见的 publishable/anon key。绝不要暴露 `service_role`、其他 secret 或 owner 密码。部署前先完成 SQL migration 和 Auth owner 创建；本仓库没有替你执行 provisioning。

## 故障排查

- **显示设置页**：检查 `.env.local` 是否存在且变量拼写正确，重启 dev server；也可使用 LOCAL DEMO。
- **登录失败/被拒绝**：确认 Auth 用户已创建、邮箱密码正确，并确认生产项目已执行 `002_independent_boards.sql`。新账号首次登录会得到独立空看板，不需要填写 owner UUID；过期 session 需要重新登录。
- **冲突**：另一设备保存后，当前编辑内容不会被覆盖。应用会先做三方合并：你的改动与另一台设备的改动各自独立时，两边都会保留并自动重试保存，无需手工处理。
- **真冲突**：只有同一项双方都改且结果不同时才需要你决定——云端值保留在板上，你的输入作为草稿保留，点击“重新打开编辑器”刷新到最新版本后用这份输入重新提交。也可以“加载最新（保留草稿）”或“丢弃草稿”。
- **不会整板回写**：冲突后不会用旧快照覆盖最新数据，因此另一台设备的改动不会被静默丢弃。
- **离线**：在线优先策略会拒绝保存并保留草稿；恢复网络后点击重试。
- **空白云板**：这是正常行为，真实 cloud board 从空状态开始；演示内容只在 LOCAL DEMO 中存在。
- **免费项目暂停**：到 Supabase 项目设置中恢复项目，等待 API 可用后重新载入；不要把 cloud error 当作 demo。

## 验证边界

`pnpm test` 会用 DEV-ONLY 的 `@electric-sql/pglite` 实际执行 migration 链（`001`–`004`）、每用户独立看板、CAS、RLS direct-table denial 和 single-running-timer rejection；它使用测试内的 mock `auth.uid()` JWT claim。该检查不是 live Supabase verification：尚未连接任何真实项目，生产项目仍需由管理员执行 migration、确认 Auth/RLS 配置，并用两个真实账号分别验收数据隔离。
