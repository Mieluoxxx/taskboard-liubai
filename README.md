# Liubai Taskboard

一个安静的个人双端规划工作区：长期目标、ISO 周计划、日计划和专注计时器保持四列横向模型。默认中文，可切换英文。

[MIT 许可](LICENSE)。

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
2. 在 Auth 用户页用管理员方式创建唯一 owner 邮箱/密码，复制该用户 UUID；不要把密码写入仓库或 `.env`。
3. 在 SQL Editor 中完整执行 `supabase/migrations/001_private_board.sql` 的 DDL。然后将文件顶部注释里的 `REPLACE_WITH_OWNER_UUID` 替换成第 2 步 UUID，单独执行那条 `insert into private.owner_config...`。这会把 owner 写入受保护配置；migration 和 provisioning 尚未在任何项目执行，也没有创建云资源。
4. 只把 `VITE_SUPABASE_URL` 与 publishable key（旧项目可用 anon key）写入 `.env.local`，重启 Vite。登录后会校验 owner UUID；其他账号会被拒绝。
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
- **登录失败/被拒绝**：确认 Auth 用户已创建、邮箱密码正确且用户 UUID 与 SQL 中的 owner UUID 一致。过期 session 需要重新登录。
- **冲突**：另一设备保存后，当前编辑内容不会被覆盖。应用会先做三方合并：你的改动与另一台设备的改动各自独立时，两边都会保留并自动重试保存，无需手工处理。
- **真冲突**：只有同一项双方都改且结果不同时才需要你决定——云端值保留在板上，你的输入作为草稿保留，点击“重新打开编辑器”刷新到最新版本后用这份输入重新提交。也可以“加载最新（保留草稿）”或“丢弃草稿”。
- **不会整板回写**：冲突后不会用旧快照覆盖最新数据，因此另一台设备的改动不会被静默丢弃。
- **离线**：在线优先策略会拒绝保存并保留草稿；恢复网络后点击重试。
- **空白云板**：这是正常行为，真实 cloud board 从空状态开始；演示内容只在 LOCAL DEMO 中存在。
- **免费项目暂停**：到 Supabase 项目设置中恢复项目，等待 API 可用后重新载入；不要把 cloud error 当作 demo。

## 验证边界

`pnpm test` 会用 DEV-ONLY 的 `@electric-sql/pglite` 实际执行 migration、CAS、owner denial、RLS direct-table denial 和 single-running-timer rejection；它使用测试内的 mock `auth.uid()` JWT claim。该检查不是 live Supabase verification：尚未连接任何真实项目，生产项目仍需由管理员执行 migration、确认 Auth/RLS 配置，并用真实 owner session 做一次验收。
