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
- 测试：单元 + 集成 171 条，端到端 37 条（加入/同步/安全/聊天·重连·缓存），全绿；typecheck 干净
- **Task 0 真机验收通过**（2026-10-18）：用户在自己的手机上打开
  `spike/verify.html`，R1（音频播放）、R1b（真实 mp3）、R2（选文件夹）、
  R3（锁屏后台存活）四项全部正常。**纯网页方案的地基由此确认成立**，
  `docs/spec.md` §2 的 D2 决策无需重新评估
- 修掉一个会让**整页白屏**的兼容性问题：`crypto.randomUUID()` 是安全上下文
  专属 API，而安全上下文不只是 HTTPS —— `http://localhost` 算，
  `http://192.168.1.5` 这种局域网地址**不算**。Join 在渲染时就要用 clientId，
  一抛异常整个应用都出不来，手机上还没有控制台可看。改成用
  `getRandomValues` 兜底，并给首屏渲染加了兜底错误提示（不再是白屏）
- E2E 的本地状态改成独立目录 `.wrangler/e2e-state` 且每轮清空，
  与 `npm run dev:worker` 的 `.wrangler/state` 隔离。之前两者共用一份，
  累积到 75 MB 之后开始出现"上传静默不落地"这种毫无线索的失败

### 尚未完成

- 安卓端没有单独跑过能力验证页（用户其他成员的设备）。
  安卓 Chrome 在这三件事上比 ArkWeb 宽松，风险低，但没验过就是没验过
- 完整流程还没有在任何手机上跑过。可以不部署先验：电脑上
  `npx wrangler dev --ip 0.0.0.0 --port 8787`，手机开 `http://<电脑IP>:8787`。
  注意局域网 HTTP 不是安全上下文，PWA 安装与锁屏媒体控制在这条路上用不了，
  那两项要等部署到 HTTPS 之后才能验
- 部署：`wrangler r2 bucket create musictogether-tracks` →
  `wrangler secret put SESSION_SECRET` → `npm run deploy`（用户要求先不做）
- 部署后要补的三条上线检查（本地无法验证）：生产密钥、R2 桶不公开、HSTS
- `cloudflare:test` 的 `env`/`SELF` 已废弃，应迁移到 `cloudflare:workers`
  的 `env` 与 `exports.default.fetch()`

### 执行中发现的、值得记住的事

- 写代码时暴露的规格空白与偏差，记在 `docs/spec.md` 顶部的「实现过程中与规格的偏差」
- 本地跑 E2E 必须靠 `.dev.vars` 里的 `RATE_LIMIT_SCALE` 放宽限速，
  否则测试套件会被自己的限速挡住；集成测试那层显式锁回 1
- E2E 用系统 Edge（`channel: 'msedge'`），因为下载 Playwright 自带浏览器会失败
- 想在 E2E 里模拟 WebSocket 断线，`context.setOffline(true)` 与 `routeWebSocket` 都不行：
  前者只挡新请求，已建好的连接照样活着；后者只拦新连接。
  可行做法是 `addInitScript` 把 WebSocket 实例挂到 `window` 上，再从外面 `close()`
- **调试时强杀 workerd 会弄坏本地状态库**（`SQLITE_BUSY_RECOVERY`），
  之后的表现是零星的、看不出原因的失败。要停 dev server 就正常 Ctrl-C；
  已经坏了就删掉对应的 persist 目录
- **E2E 里的时间比较必须两端在同一时刻取**。曾经有一条用例拿"进房前"的
  A 快照去比"进房后"的 B，diff 恒等于进房耗时，机器一慢就假红
