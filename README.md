# MusicTogether

和别人一起听同一首歌，进度条保持同步。

A 把自己设备上的歌传上去，房间里所有人听到同一首歌。不是实时音频推流 ——
音频经云端中转一次，之后各自播放自己那份副本，**同步的只是时间轴与播放状态**。
浏览器直达，不经过任何应用商店。

跑在 Cloudflare 上：Workers + Durable Objects（每个房间一个）+ R2（音频字节）。

---

## 现在能做什么

配对开房 · 上传（电脑选目录 / 手机选文件）· 共享队列与调序 · 播放/暂停/切歌/拖进度条
（**平权**，谁都能控）· 服务端权威的锚点同步（±1 秒）· 本地缓存与删除 ·
内置文字聊天 · 断线自动重连 · 多人 · PWA 可安装 · 锁屏媒体控制。

| | |
|---|---|
| 测试 | 单元 + 集成 171 条、端到端 37 条，全绿 |
| 运行时依赖 | 只有 `preact` 与 `@preact/signals` |
| 免费额度 | 小规模自用绰绰有余，明细见 `docs/spec.md` §12 |

**还没做过的事**：没有部署到 Cloudflare，也没有在真机上跑过完整流程。
`docs/spec.md` §2 列的三条前提假设（手机浏览器能播、能选文件夹、锁屏后音频不死）
目前只有一份验证页待人工确认，见下面「真机验收」。

---

## 快速开始

需要 Node **22.12+**（wrangler 要求 ≥22，vite 要求 ≥22.12）。

```bash
npm install
cp .dev.vars.example .dev.vars      # 本地开发密钥，已被 gitignore
```

开两个终端：

```bash
npm run dev:worker      # Worker + API，8787
npm run dev             # 前端开发服务器，5173（/api 自动代理到 8787）
```

然后浏览器打开 <http://localhost:5173>。要试两个人，开一个无痕窗口 ——
身份存在 `localStorage` 里，同一个浏览器 profile 的普通窗口会共用同一个身份，
开第二个窗口只会看到"你自己"。

> `.dev.vars` 里的 `SESSION_SECRET` 只用于本地。**生产密钥走
> `wrangler secret put`，绝不进仓库。**

## 测试

```bash
npm run typecheck       # 前端与服务端两套 tsconfig
npm test                # 单元 + 集成（真实 workerd + Durable Object + R2 模拟）
npm run test:e2e        # Playwright，跑的是构建产物，起在 8788
```

E2E 用系统 Edge（`channel: 'msedge'`），不下载 Playwright 自带浏览器。
`.dev.vars` 里的 `RATE_LIMIT_SCALE` 是给 E2E 用的限速逃生口 ——
本地所有请求都来自同一个 IP，不放宽的话测试套件会把自己挡住；
集成测试那一层显式把它锁回 1，所以限速本身仍然是被测对象。

E2E 的本地状态放在 `.wrangler/e2e-state`，**每轮开跑前清空**，跟
`npm run dev:worker` 用的 `.wrangler/state` 完全隔离。所以跑测试不会动到你
开发中的房间和歌，测试之间也不会互相带脏数据 —— 状态跨轮累积到几十 MB 之后，
失败会以"上传静默不落地"这种完全看不出原因的形式出现。

## 部署

需要一个 Cloudflare 账号。首次：

```bash
npx wrangler login
npx wrangler r2 bucket create musictogether-tracks
npx wrangler secret put SESSION_SECRET      # 32 字节以上的随机值
npm run deploy
```

上线前请逐条过 `docs/security.md` §5 的检查清单。

## 真机

**能力验证已通过**（2026-10-18）：`spike/verify.html` 在手机上逐项验证，
R1 音频播放、R1b 真实 mp3、R2 选文件夹、R3 锁屏后台存活全部正常。
纯网页方案的地基由此确认成立。安卓端还没单独验过（风险低，见 `docs/spec.md` §2）。

**还没做**：完整流程没在任何手机上跑过。可以先不部署就验 —— 电脑上：

```bash
npx wrangler dev --ip 0.0.0.0 --port 8787
```

手机浏览器开 `http://<电脑局域网 IP>:8787`，两台设备就能配对、上传、同步。

> 局域网 HTTP **不是安全上下文**，所以这条路验不了 PWA 安装与锁屏媒体控制，
> 那两项要等部署到 HTTPS 之后。其余功能（含音频播放与 WebSocket 同步）都正常。

---

## 文档地图

| 文件 | 给谁看 | 内容 |
|------|--------|------|
| `docs/spec.md` | 想搞懂设计的人 | 决策记录（D1–D10）、架构、数据模型、同步算法、WS 协议、HTTP API、免费额度核算，以及实现中与规格的偏差 |
| `docs/security.md` | 改代码前**必读** | 威胁模型、逐条对策（以及每条防不住什么）、安全回归清单、上线前检查清单 |
| `docs/superpowers/plans/` | 想追溯怎么做的 | 逐任务的实现计划与验收步骤 |
| `AGENTS.md` | AI agent | 稳定约定与安全红线（压缩版） |
| `memory/progress.md` | 接手的人 | 进展、未完成事项、踩过的坑 |

## 目录结构

```
src/shared/    前后端共用，只能是纯函数与类型（房间码、播放锚点、协议）
src/server/    Worker 侧（路由、鉴权、安全闸门、RoomDO、R2 读写）
src/client/    浏览器侧（Preact + signals、播放器、缓存、聊天）
test/unit/     跑在 node
test/integration/  跑在 workerd
test/e2e/      Playwright
spike/         真机能力验证页（一次性）
```

## 一条设计上的取舍

音频**不做**实时推流，而是"上传 → 云端中转 → 各自播放本地副本"。
这样不需要 WebRTC、不需要时钟对齐、断网也能继续听，代价是换歌时要等上传完成。
理由与其它九条决策记在 `docs/spec.md` §1。

服务端只服务**私密房间**：房间码是唯一入口，文件路径是不可猜的 UUID，
不提供任何"公开分享"能力。这是不让事情变质的唯一关键约束。
