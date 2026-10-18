# 项目进展

> 按用户的分层约定：`CLAUDE.md` 只放稳定约定，进展与决策记录写在这里。
> 最新的在最上面。

## 2026-10-18

### 已完成

- 规格定稿（`docs/spec.md`，D1–D10 十条决策全部与用户确认过）
- 威胁模型（`docs/security.md`）
- 实现计划（`docs/superpowers/plans/2026-10-18-musictogether-mvp.md`，Task 0–17）
- Task 1–16 全部实现：脚手架、共享纯逻辑、安全闸门与会话、RoomDO、
  播放锚点同步、上传 R2、Range 流式播放、队列、前端骨架、播放器、
  上传 UI、本地缓存、聊天、断线重连、PWA 与锁屏控制
- Task 17 安全回归：`test/e2e/security.spec.ts` 12 条 + 人工 curl 渗透验证
- 测试：单元 + 集成 171 条，端到端 34 条，全绿；typecheck 干净

### 尚未完成

- **Task 0 真机验收**：`spike/verify.html` 要在HarmonyOS 手机上打开，验证
  R1（`<audio>` 能播）、R1b（真实歌曲）、R2（选文件夹）、R3（后台存活）。
  这一条是整个纯网页方案的前提，还没做。
- 部署：`wrangler r2 bucket create musictogether-tracks` →
  `wrangler secret put SESSION_SECRET` → `npm run deploy`
- 部署后要补的三条上线检查（本地无法验证）：生产密钥、R2 桶不公开、HSTS
- 真机跑完整流程（鸿蒙 + 安卓各一遍）
- `cloudflare:test` 的 `env`/`SELF` 已废弃，应迁移到 `cloudflare:workers`
  的 `env` 与 `exports.default.fetch()`

### 执行中发现的、值得记住的事

- 写代码时暴露的规格空白与偏差，记在 `docs/spec.md` 顶部的「实现过程中与规格的偏差」
- 本地跑 E2E 必须靠 `.dev.vars` 里的 `RATE_LIMIT_SCALE` 放宽限速，
  否则测试套件会被自己的限速挡住；集成测试那层显式锁回 1
- E2E 用系统 Edge（`channel: 'msedge'`），因为下载 Playwright 自带浏览器会失败
