# 项目进展

> 记录实现进度、关键决策与踩过的坑。最新的在最上面。

## 2026-10-20

- Android 端实测可正常访问与播放（此前只在 HarmonyOS 上验证过）。
- 为开源发布做了一轮整理：重写 README、补充 MIT 许可证、把文档里只对原始
  私有部署成立的一次性表述改成中性描述，并对全部提交历史做了脱敏
  （个人信息、内网地址、房间码、提交邮箱）。
- 集成测试迁到 `cloudflare:workers` 的 `env` 与 `exports.default`，
  `cloudflare:test` 的 `SELF`/`env` 已废弃；`GlobalProps.mainModule` 让
  `exports.default` 在测试里保持主 worker 的类型。

## 2026-10-19

### 3D 舞台（`feature/3d-stage`）

- 主题是房间级、服务端权威：协议增加 `theme`，落进 `RoomState` 并广播；
  白名单在 `src/shared/themes.ts`，服务端与客户端共用一份
- 两个主题：「晨光」（粉白 / 浅橙 / 淡墨绿）与「余烬」（深底暖橙 +
  发光扭曲线框球）。两个主题并存，房间级切换
- 黑胶唱片机不属于任何主题，由 Stage 恒定持有 —— 切主题时它一直在转
- 律动三层兜底：主路 `captureStream()`（不重路由 audio 元素的输出）→
  备路 `createMediaElementSource()` → 程序化曲线。音频能量只在本地计算，不上行
- 三条降级路径都不影响播放：拿不到 WebGL、three 的 chunk 拉不下来、运行期抛异常
- 画质只降不升，按实测帧时间判定，档位存在本地、不上行
- 首屏增长 1.7 KB（42,798 B → 44,577 B）。整棵场景树走动态 import，
  是一个独立的 5.6 KB chunk；three 另在 736 KB 的 chunk 里，进房间才拉

**踩坑**：`npx vitest` 曾被 RTK 钩子解析成另一个 vitest，集成测试池起不来。
用 `npm test` 或 `node node_modules/vitest/vitest.mjs run` 直接跑是全绿的。

### 成员在线状态

`online` 只管「连接还在」，客户端另外上报 `away` 表示「页面在不在前台」。
最小化窗口、切到别的应用、手机按 Home 都不会断开 WebSocket，只看连接状态
会把人误判为在线。界面上用绿点 / 灰点表示，点在名字右边。列表上限 20，
只淘汰离线最久的成员。

### 聊天落库

聊天不再只是广播，而是单独存一个键，不并进 `RoomState`（后者每次播放/暂停
都会整个 save 一遍）。快照只带最近 200 条，更早的走
`GET /api/rooms/:code/chat?before=<id>`。聊天框改成固定高度 + 滚动，
顺带修掉「往上翻历史会被新消息拽回底部」。

### 歌词（已探明，暂不做）

对本地音乐库的 402 个 mp3 做过探针：内嵌歌词 0 个（USLT/SYLT 全无，
ID3 里只有歌手/标题/专辑/注释），但 322 个（80.1%）有同名 `.lrc`。
所以「读 ID3 内嵌」这条路是死的，`.lrc` 那条路是通的。暂不做。
探针脚本是一次性的，跑完即弃，没进仓库。

### 同步精度用例的取样方式

`test/e2e/sync.spec.ts` 与 `features.spec.ts` 里有几处顺序取两端的
`currentTime`，差值里混进了两次 `page.evaluate` 的往返时间，实测 1.03–1.5 秒，
正好压在阈值上造成假红。改成 `Promise.all` 同时取。

### 尚未完成

- 3D 舞台真机验收：HarmonyOS / Android 的 WebGL 均已可用，锁屏 / 切后台后
  音频继续播放也已复现；仍缺连续播放 30 分钟的温度与掉帧观察
- 两个主题的观感只有代码与 E2E 覆盖，还没有人工过目；手机自动降画质的
  实际效果也未验证
- PWA 安装与锁屏媒体控制没有验证过：局域网 HTTP 不是安全上下文，
  Service Worker 装不上，要等 HTTPS（部署，或用 `cloudflared tunnel`
  临时把本地 dev server 暴露成 HTTPS）

## 2026-10-18

### 已完成

- 规格定稿（`docs/spec.md`，D1–D10 十条决策在实现前逐条确认）
- 威胁模型（`docs/security.md`）
- 实现计划（`docs/superpowers/plans/2026-10-18-musictogether-mvp.md`，Task 0–17）
- Task 1–16 全部实现：脚手架、共享纯逻辑、安全闸门与会话、RoomDO、
  播放锚点同步、上传 R2、Range 流式播放、队列、前端骨架、播放器、
  上传 UI、本地缓存、聊天、断线重连、PWA 与锁屏控制
- Task 17 安全回归：`test/e2e/security.spec.ts` 12 条 + 人工 curl 渗透验证
- 测试：单元 + 集成 171 条，端到端 45 条，全绿；typecheck 干净
- **方案地基真机验证通过**：在 HarmonyOS 手机真机上打开 `spike/verify.html`，
  R1（音频播放）、R1b（真实 mp3）、R2（选文件夹）、R3（锁屏后台存活）
  四项全部正常。纯网页方案成立，`docs/spec.md` §2 的 D2 决策无需重新评估
- 修掉一个会让**整页白屏**的兼容性问题：`crypto.randomUUID()` 是安全上下文
  专属 API，而安全上下文不只是 HTTPS —— `http://localhost` 算，
  `http://192.168.1.5` 这种局域网地址不算。Join 在渲染时就要用 clientId，
  一抛异常整个应用都出不来，手机上还没有控制台可看。改成用
  `getRandomValues` 兜底，并给首屏渲染加了兜底错误提示
- **完整流程真机验证通过**：手机（HarmonyOS 浏览器）经局域网地址连到开发机上
  跑的 `wrangler dev`，**手机上传**一首歌，两台设备都能听到，成员列表正确。
  这一轮覆盖了 D8 的移动端上传路径、局域网 HTTP 下整条链路与真机上的实际播放
- **两端同步精度实测通过**：真机上两端秒级同步，满足 D5 的 ±1 秒
- **R3 在完整应用里复现**：手机锁屏、切到其他 app 后音频继续播放。
  （锁屏界面上的媒体控制按钮没有单独确认过 —— 那是 Media Session，
  跟「能不能继续听」是两件事）
- E2E 的本地状态改成独立目录 `.wrangler/e2e-state` 且每轮清空，
  与 `npm run dev:worker` 的 `.wrangler/state` 隔离。之前两者共用一份，
  累积到 75 MB 之后开始出现「上传静默不落地」这种毫无线索的失败

### 局域网开发

`npm run dev:lan`（`scripts/dev-lan.mjs`）绑定 `0.0.0.0`、挑出真正的局域网网卡
（把 WSL / VMware 等虚拟网卡排到后面）、打印可访问的地址。

脚本存在的理由不只是「方便」：操作者自己也必须从局域网地址进入。
「分享房间」的链接按 `location.origin` 生成，从 `localhost` 进入时生成的就是
`http://localhost:8787/r/CODE` —— 在其他设备上打不开，而且没有任何提示。

这条路的已知限制（明文 HTTP + 自建服务的固有代价）：
PWA 装不上 / 没有离线能力；访客网络若做了客户端隔离则连不通；
同网段的人扫到 8787 就能打开页面，而建房不需要任何凭据。

### 分支布局

| 分支 | 状态 |
| ---- | ---- |
| `master` | 稳定版。没有成员在线状态、聊天落库、聊天框、3D 舞台 |
| `feature/3d-stage` | 上面全部，3D 计划 11 个任务做完 |

### 开发环境踩坑

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
- **E2E 里的时间比较必须两端在同一时刻取**。曾经有一条用例拿「进房前」的
  A 快照去比「进房后」的 B，diff 恒等于进房耗时，机器一慢就假红
- **git bash 的 `$!` 是 MSYS 自己的 PID，不是 Windows PID**，而 `taskkill`
  要的是后者。拿 `$!` 去杀永远杀不掉，表现是「端口一直被新进程重新占上」——
  其实一直是同一个没杀掉的进程。要按 Windows PID 杀就用
  `Get-CimInstance Win32_Process` 查
- **`spawn(..., { shell: true })` 在 Windows 上会多夹一层 `cmd.exe`**，
  那层不在 node 的进程树里，程序化收尾杀不干净，会在 `0.0.0.0:8787` 上留下
  孤儿 `workerd`。起 wrangler 直接 `node node_modules/wrangler/bin/wrangler.js`，
  别过 `npx`
- **新建 worktree 之后要手动 `cp .dev.vars .dev.vars`**。它是 gitignore 的，
  worktree 等于一份全新检出，不补的话集成测试整个跑不起来
  （报的是 `SESSION_SECRET missing`）
- **`EnterWorktree` 工具在这个仓库用不了** —— harness 认为它不是 git 仓库，
  而 Bash 里的 git 一切正常。退回手搓
  `git worktree add .worktrees/<名字> -b <分支>`，
  记得先把 `.worktrees/` 写进 `.gitignore`
- **RTK 钩子会把 `ls` 的输出改成带体积的形式**，`ls | sed 's/.*\.//'` 这类
  按行切字段的统计会静默算错。要统计文件类型就用 Node 或 `find`
- **RTK 会把 vitest 的输出压成 `PASS (n) FAIL (n)`**，失败原因全看不见。
  它同时留了原始日志，路径在输出里，从那里读 JSON 才拿得到 message
- **`npx vitest` 不可信。** 它会解析到另一个 vitest，集成测试池起不来，
  报的是 `Cannot read properties of undefined (reading 'config')` ——
  看起来像代码坏了，其实是工具链。用 `npm test` 或
  `node node_modules/vitest/vitest.mjs run`
- **E2E 跑着的时候不要 `npm run build`。** `emptyOutDir` 会把服务器正在用的
  `dist/` 整个换掉，表现是随机几条用例「进不了房间」，而且红的是完全无关的用例。
  Playwright 的 webServer 只在开跑时构建一次
- **`page.route` 拦不到 Service Worker 发起的请求。** 想拦某个 chunk 来模拟
  加载失败，必须 `browser.newContext({ serviceWorkers: 'block' })`，
  否则那条用例会静默地什么都没测到
- **Vite 8 走 rolldown**：`manualChunks` 的对象形式直接报
  `TypeError: manualChunks is not a function`，`advancedChunks` 也已废弃，
  现在叫 `codeSplitting.groups`
