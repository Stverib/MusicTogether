# 项目进展

> 按用户的分层约定：`CLAUDE.md` 只放稳定约定，进展与决策记录写在这里。
> 最新的在最上面。

## 2026-10-19

### 3D 舞台：做完了（`feature/3d-stage`）

10 个任务全部落地，外加一个用户中途追加的第二个主题。

- **主题是房间级、服务端权威**：协议加 `theme` 一条，落进 `RoomState` 并广播；
  白名单在 `src/shared/themes.ts`，服务端与客户端共用一份
- **两个主题**：「晨光」（粉白 / 浅橙 / 淡墨绿，原定）与「余烬」
  （深底暖橙 + 发光扭曲线框球，用户给了一张 Three.js 演示截图作为参考）。
  两个并存、房间级切换，切换器因此第一次出现
- **黑胶唱片机不属于任何主题**，由 Stage 恒定持有 —— 切主题时它一直在转
- **律动三层兜底**：主路 `captureStream()`（不重路由 audio 元素的输出）→
  备路 `createMediaElementSource()` → 程序化曲线。音频能量只在本地算，绝不上行
- **三条降级路径**都不影响播放：拿不到 WebGL、three 的 chunk 拉不下来、运行期抛异常
- **画质只降不升**，按实测帧时间判定，档位存在本地、不上行
- **首屏增长 1.7 KB**（42,798 B → 44,520 B）。整棵场景树走动态 import，
  是一个独立的 5.6 KB chunk；three 另在 736 KB 的 chunk 里，进房间才拉

**卡过一下的地方**：`memory/progress.md` 里原来记的"`theme.test.ts` 加载失败、
原因没查清"**不是代码问题** —— 是 RTK 钩子把 `npx vitest` 解析成了另一个
vitest，集成测试池起不来。用 `npm test` 或
`node node_modules/vitest/vitest.mjs run` 直接跑是全绿的。**别再信 `npx vitest`。**

### 成员在线状态：离开页面即算离开（用户追加）

`online` 只管"连接还在"，新加一个客户端上报的 `away` 管"页面在不在前台"。
最小化窗口、切到别的应用、手机按 home 都**不会**断开 WebSocket，只看连接状态
的话人明明走了点还是绿的。界面上绿点/灰点，点在名字右边。

### 同步精度用例的取样方式（顺带修掉）

`test/e2e/sync.spec.ts` 与 `features.spec.ts` 里几处**顺序**取两端的
`currentTime`，差值里混进了两次 `page.evaluate` 的往返时间，实测 1.03~1.5 秒，
正好压在阈值上假红。改成 `Promise.all` 同时取。

### 尚未完成（本节新增）

- **3D 舞台的真机验收**（只有用户能做）：HarmonyOS 浏览器上 WebGL 是否可用；
  连续播放 30 分钟摸温度、看是否掉帧；锁屏 / 切后台后音频**继续播放**
  （这是本次唯一可能回退已验收能力的地方）
- 两个主题的观感只有代码与 E2E 覆盖，**没有人真正看过**。手机上自动降画质
  的实际效果也没人看过

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

### 用户用后追加的四件（2026-10-18）

在 `feature/3d-stage` 分支上做（worktree `.worktrees/3d-stage`）。它们与 3D 无关，
只是恰好落在同一条分支上；做完时可以单独快进到 master，不必等 3D。

- **成员在线 / 已离开**（已完成）：推翻"断线即移除"。`Member` 加 `online`，
  断线只翻标志不删人，同 `clientId` 重连翻回来。列表上限 20，**只淘汰离线的最老的**
- **聊天落库**（已完成）：推翻"聊天不落库"。聊天**单独一个存储键**，不并进
  `RoomState`（后者每次播放/暂停都整个 save 一遍）。快照只带最近 200 条，
  更早的走 `GET /api/rooms/:code/chat?before=<id>`。两条决策变更记在 `docs/spec.md` §1.2
- **聊天框固定高度 + 滚动**（已完成）：`max-height` 改 `height`；
  顺带修掉"往上翻历史会被新消息拽回底部"
- **歌词**（已探明，暂不做）：对用户 `本地音乐目录` 的 402 个 mp3 做过探针，
  **内嵌歌词 0 个**（USLT/SYLT 全无，ID3 里只有歌手/标题/专辑/注释），
  但 **322 个（80.1%）有同名 `.lrc`**。所以"读 ID3 内嵌"这条路是死的，
  而 `.lrc` 那条路是通的。用户决定暂时不做

探针脚本是一次性的，跑完即弃，没进仓库。

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
- **3D 舞台**：设计规格与实现计划都已写好并获用户批准
  （`docs/superpowers/specs/2026-10-18-3d-stage-design.md`、
  `docs/superpowers/plans/2026-10-18-3d-stage.md`，10 个任务）。
  在 `feature/3d-stage` 分支上做（worktree `.worktrees/3d-stage`）。
  首个主题「晨光」（粉白 / 浅橙 / 淡墨绿），星空 / 海边 / 赛博朋克暂时不做。
  主题是房间级、服务端权威（要动协议与 DO）。
  **可行性已实测**：three r186 的核心 0 处 `eval` / `new Function` / blob worker，
  所以 CSP 一行都不用改，红线 15 守得住。
  进度与卡住的地方见下一节
- `cloudflare:test` 的 `env`/`SELF` 已废弃，应迁移到 `cloudflare:workers`
  的 `env` 与 `exports.default.fetch()`

### 分支布局（2026-10-19 收尾后）

| 分支 | 状态 |
|------|------|
| `master` | 稳定版。**没有**成员在线状态、聊天落库、聊天框、3D 舞台 |
| `feature/3d-stage` | 上面全部，3D 计划 11 个任务做完。`wip/3d-theme-server` 已并入并删除 |

（原来这里记的"Task 2 卡在 theme.test.ts 加载失败"**是个误判**，
原因见下面「执行中发现的」里的 `npx vitest` 那条。）

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
- **新建 worktree 之后要手动 `cp .dev.vars .dev.vars`**。它是 gitignore 的，
  worktree 等于一份全新检出，不补的话集成测试整个跑不起来
  （报的是 `SESSION_SECRET missing`，一看就懂，但第一次会愣一下）
- **`EnterWorktree` 工具在这个仓库用不了** —— harness 认为它不是 git 仓库
  （环境里那句 `Is a git repository: false`），而 Bash 里的 git 一切正常。
  退回手搓 `git worktree add .worktrees/<名字> -b <分支>`，
  记得先把 `.worktrees/` 写进 `.gitignore`
- **RTK 钩子会把 `ls` 的输出改成带体积的形式**，`ls | sed 's/.*\.//'` 这类
  按行切字段的统计会静默算错（切到体积上）。要统计文件类型就用 Node 或 `find`
- **RTK 会把 vitest 的输出压成 `PASS (n) FAIL (n)`**，失败原因全看不见。
  它同时留了原始日志，路径在输出里，从那里读 JSON 才拿得到 message
- **`npx vitest` 不可信。** 它会解析到另一个 vitest，集成测试池起不来，
  报的是 `Cannot read properties of undefined (reading 'config')` ——
  看起来像代码坏了，其实是工具链。用 `npm test` 或
  `node node_modules/vitest/vitest.mjs run`
- **E2E 跑着的时候不要 `npm run build`。** `emptyOutDir` 会把服务器正在用的
  `dist/` 整个换掉，表现是随机几条用例"进不了房间"（`header strong` 找不到），
  而且红的是完全无关的用例。Playwright 的 webServer 只在开跑时构建一次
- **`page.route` 拦不到 Service Worker 发起的请求。** 想拦某个 chunk 来模拟
  加载失败，必须 `browser.newContext({ serviceWorkers: 'block' })`，
  否则那条用例会静默地什么都没测到 —— 一条永远绿的装饰
- **Vite 8 走 rolldown**：`manualChunks` 的对象形式直接报
  `TypeError: manualChunks is not a function`，`advancedChunks` 也已废弃，
  现在叫 `codeSplitting.groups`
