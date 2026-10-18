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
- 测试：单元 + 集成 171 条，端到端 45 条（加入/分享/同步/安全/聊天·重连·缓存），全绿；typecheck 干净
- **Task 0 真机验收通过**（2026-10-18）：用户在自己的手机上打开
  `spike/verify.html`，R1（音频播放）、R1b（真实 mp3）、R2（选文件夹）、
  R3（锁屏后台存活）四项全部正常。**纯网页方案的地基由此确认成立**，
  `docs/spec.md` §2 的 D2 决策无需重新评估
- 修掉一个会让**整页白屏**的兼容性问题：`crypto.randomUUID()` 是安全上下文
  专属 API，而安全上下文不只是 HTTPS —— `http://localhost` 算，
  `http://192.168.1.5` 这种局域网地址**不算**。Join 在渲染时就要用 clientId，
  一抛异常整个应用都出不来，手机上还没有控制台可看。改成用
  `getRandomValues` 兜底，并给首屏渲染加了兜底错误提示（不再是白屏）
- **真机完整流程验收通过**（2026-10-18）：手机（HarmonyOS 浏览器）开局域网地址
  `http://192.168.1.5:8787` 连到开发机上跑的 `wrangler dev`，房间 `K7M2QX`，
  **手机上传**了 `example.mp3`，两台设备都能听到，成员列表 2 人，
  连接指示为绿。
  这一轮同时验掉了三件之前只有测试覆盖的事：D8 的**手机上传**路径、
  局域网 HTTP 下整条链路、以及真机上的实际播放
- **两端同步精度实测通过**（2026-10-18）：真机上手机与电脑"基本秒级同步"，
  满足 D5 定的 ±1 秒
- **R3 在完整应用里复现**（2026-10-18）：手机锁屏、切到其他 app 后音频继续播放。
  （锁屏界面上的媒体控制按钮没有单独确认过 —— 那是 Media Session，
  跟"能不能继续听"是两件事）
- 修掉一个会让**整页白屏**的兼容性问题：`crypto.randomUUID()` 是安全上下文
  专属 API，而安全上下文不只是 HTTPS —— `http://localhost` 算，
  `http://192.168.1.5` 这种局域网地址**不算**。Join 在渲染时就要用 clientId，
  一抛异常整个应用都出不来，手机上还没有控制台可看。改成用
  `getRandomValues` 兜底，并给首屏渲染加了兜底错误提示（不再是白屏）。
  **这条路正是真机验收要走的路**，不修就卡在这里
- E2E 的本地状态改成独立目录 `.wrangler/e2e-state` 且每轮清空，
  与 `npm run dev:worker` 的 `.wrangler/state` 隔离。之前两者共用一份，
  累积到 75 MB 之后开始出现"上传静默不落地"这种毫无线索的失败

### 部署受阻：中国大陆网络下的实测结论（2026-10-18）

为了判断"无法完成付费流程怎么办"，做了一轮实测（探针 Worker 已删除）：

| 目标 | 结果 |
|------|------|
| `wrangler deploy`（探针 Worker） | ✅ **成功，不需要绑卡** |
| `wrangler r2 bucket create` | ❌ code 10042，R2 必须先过仪表盘的付费流程 |
| `*.workers.dev` | ❌ DNS 被污染成 Facebook 的 IP（`2a03:2880:f10f:83:face:b00c:0:25de` / `69.63.187.12`），连接 20s 超时 |
| `*.vercel.app` | ❌ 同样污染成 Facebook IP，连接 15s 超时 |
| `cloudflare.com` | ✅ 200，0.5s |
| `vercel.com` | ✅ 200，0.8s |

**结论一：免费平台子域这条路整体是死的。** `workers.dev` / `vercel.app`
被针对性封锁（不是平台被墙——平台主站都通，被墙的是**共享的免费子域**，
`pages.dev`、`netlify.app`、`onrender.com` 属同一类，机制相同）。
换任何一家免费 PaaS 都绕不过去，**必须有自己的域名**。

**结论二：域名不再是可选项。** 而且这一条对部署在哪儿都一样成立：
自建 VPS 要 HTTPS 才有安全上下文（PWA / Service Worker / 剪贴板），
Let's Encrypt 也签不了纯 IP。

**结论三：卡住的一直是两件事，不是一件** —— R2 要国际卡，
免费子域在大陆不可达。只解决其中一个都不够。

待定的三条路（都需要先买域名，¥30–80/年，支持常见支付方式）：

1. **香港轻量服务器**（腾讯云/阿里云，约 ¥25–40/月，香港区免备案）——
   音频放本地磁盘，Node + `ws` 一个进程全包。体验最好（大陆到香港 30–60ms），
   但 `src/server/` 要从 Worker/DO 改写成 Node 进程（客户端与 `src/shared/` 不动）
2. **Cloudflare Workers + 自有域名 + 用 KV 顶替 R2**（约 ¥40/年，零月费）——
   KV 免费 1 GB / 10 万次读/日，单值上限 25 MiB。
   代价：KV 不支持 Range，`/stream` 要读整个值再切片（25 MB 上限、CPU 更吃紧），
   且从大陆访问 Cloudflare 边缘通常 200–400ms
3. **虚拟信用卡**（如 WildCard，约 ¥100/年）→ 维持现有 R2 架构，零代码改动。
   风险是 Cloudflare 的付费流程可能不收虚拟卡

**用户的决定（2026-10-18）：暂时不部署，域名也先不买。** 先由本地开发机
跑服务，其他成员通过局域网访问。上面三条路都留着，等哪天要"任何网络都能用"再挑。

为这条路补了 `npm run dev:lan`（`scripts/dev-lan.mjs`）：绑 `0.0.0.0`、
挑出真正的局域网网卡（把 WSL / VMware 那些别人连不上的虚拟网卡排到后面）、
把地址打印出来。实测 `http://192.168.1.5:8787` 出页面、
`/r/<房间码>` 出 SPA、静态外壳的安全响应头齐全。

写这个脚本的**真正理由不是"方便"**：必须让操作者自己也从局域网地址进。
「分享房间」的链接是按 `location.origin` 生成的，从 `localhost` 进生成的就是
`http://localhost:8787/r/CODE` —— 发给其他参与者打不开，而且没有任何提示，
只有对方点开才知道。脚本把这件事直接打在屏幕上。

这条路已知的三个限制（都不是 bug，是明文 HTTP + 自建服务的固有代价）：
PWA 装不上 / 没有离线能力；局域网若做了客户端隔离则连不通；
同网段的人扫到 8787 就能打开页面，而建房不需要任何凭据。

### 尚未完成

- **PWA 安装与锁屏媒体控制没有验过**：局域网 HTTP 不是安全上下文，
  Service Worker 装不上，也就无从验起。要等 HTTPS（部署，或用
  `cloudflared tunnel` 临时把本地 dev server 暴露成 HTTPS）
- 安卓端没有单独跑过能力验证页（用户其他成员的设备）。
  安卓 Chrome 在这三件事上比 ArkWeb 宽松，风险低，但没验过就是没验过
- 部署：见上面「部署受阻」一节。原有的三步流程
  （`wrangler r2 bucket create` → `wrangler secret put SESSION_SECRET` → `npm run deploy`）
  本身没错，但**必须先解决域名与 R2 这两件事**，否则部署出来大陆打不开
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
- **git bash 的 `$!` 是 MSYS 自己的 PID，不是 Windows PID**，而 `taskkill`
  要的是后者。拿 `$!` 去杀永远杀不掉，表现是"端口一直被新进程重新占上"——
  其实一直是同一个没杀掉的进程。要按 Windows PID 杀就用
  `Get-CimInstance Win32_Process` 查
- **`spawn(..., { shell: true })` 在 Windows 上会多夹一层 `cmd.exe`**，
  那层不在 node 的进程树里，程序化收尾杀不干净，会在 `0.0.0.0:8787` 上留下
  孤儿 `workerd`。起 wrangler 直接 `node node_modules/wrangler/bin/wrangler.js`，
  别过 `npx`
