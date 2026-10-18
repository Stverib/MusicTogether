# MusicTogether

和别人一起听同一首歌，进度条保持同步。

A 把自己设备上的歌传上去，房间里所有人听到同一首歌。不是实时音频推流 ——
音频经云端中转一次，之后各自播放自己那份副本，**同步的只是时间轴与播放状态**。
浏览器直达，不经过任何应用商店。

跑在 Cloudflare 上：Workers + Durable Objects（每个房间一个）+ R2（音频字节）。

---

## 现在能做什么

配对开房 · **分享链接邀请**（点开即进房）· 上传（电脑选目录 / 手机选文件）·
共享队列与调序 · 播放/暂停/切歌/拖进度条（**平权**，谁都能控）·
服务端权威的锚点同步（±1 秒）· 本地缓存与删除 ·
**内置聊天（记录持久化，可往上翻历史）** · 断线自动重连 ·
多人（**成员列表显示在线 / 已离开**）· PWA 可安装 · 锁屏媒体控制。

| | |
|---|---|
| 测试 | 单元 + 集成 180 条、端到端 45 条，全绿 |
| 运行时依赖 | 只有 `preact` 与 `@preact/signals` |
| 免费额度 | 小规模自用绰绰有余，明细见 `docs/spec.md` §12 |

**还没做过的事**：部署上云。卡在两件事上（R2 要国际卡；`*.workers.dev` 这类
共享免费子域在大陆被 DNS 污染后不可达），所以现在由本地开发机跑服务、
其他成员走局域网 / 局域网直连 —— 见下面「现在的用法」。

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

## 现在的用法：局域网直连（暂不部署）

2026-10-18 决定：**先不部署上云**，由本地开发机跑服务，其他成员通过局域网访问。

选这条路，是因为部署卡在**两件不同的事**上，解决其中一件都不够：

1. **R2 要国际卡** —— `wrangler r2 bucket create` 报 code 10042，
   免费额度也必须先过仪表盘的付费流程
2. **共享的免费子域在大陆不可达** —— 实测 `*.workers.dev` 与 `*.vercel.app`
   都被 DNS 污染成 Facebook 的 IP 后连接超时。平台主站本身是通的
   （`cloudflare.com` 200 / 0.5s），被针对性封锁的是那类免费子域 ——
   `pages.dev`、`netlify.app`、`onrender.com` 同理，换哪家免费 PaaS 都绕不过去

所以上云的前提是**先有一个自己的域名**（约 ¥30–80/年，支持常见支付方式，
不需要国际卡）。三条候选路径与各自代价记在 `memory/progress.md`。

### 局域网直连要知道的四件事

- **你自己也必须从局域网地址进，不能从 `localhost` 进。**「分享房间」的链接
  是按 `location.origin` 生成的 —— 从 localhost 生成的就是
  `http://localhost:8787/r/CODE`，发给其他参与者是一串打不开的东西，而且没有任何提示。
  `npm run dev:lan` 会把这件事打在屏幕上
- **局域网可能做了客户端隔离**（AP isolation）。对方打不开时先怀疑这个 ——
  同一个 WiFi 下两台设备能互通，不代表局域网里也能
- **明文 HTTP 不是安全上下文**：PWA 装不上、Service Worker 注册不了、没有离线能力；
  分享按钮会退化成「复制到剪贴板」的手动兜底（已处理，不会报错）。
  `crypto.randomUUID`、`navigator.clipboard`、`navigator.storage` 这些
  安全上下文专属 API 客户端都已经加了守卫
- **同网段的人扫到 8787 就能打开这个页面**，而且建房不需要任何凭据。
  用完 Ctrl-C 停掉，别让它一直开着

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

**完整流程也已通过**（2026-10-18）：手机开局域网地址连到开发机上跑的
`wrangler dev`，**手机上传**一首歌，两台设备都能听到，成员列表正确；
两端**秒级同步**（满足 ±1 秒的目标）；手机锁屏、切到其他 app 后音频继续播放。
复现方式 —— 电脑上：

```bash
npm run dev:lan
```

它会把本机的局域网地址挑出来打印给你，手机浏览器开那串地址即可。
（等价于 `npx wrangler dev --ip 0.0.0.0 --port 8787`，但它会替你避开
WSL / VMware 那些别人连不上的虚拟网卡，并提醒你别用 `localhost` 进 —— 原因见下一节。）

> 局域网 HTTP **不是安全上下文**，所以这条路验不了 **PWA 安装**
> （Service Worker 注册不了）。其余功能都正常，浏览器地址栏会显示"不安全"。
> 想在不部署的前提下验 PWA，用 `cloudflared tunnel --url http://localhost:8787`
> 把它临时暴露成一个 HTTPS 地址。

**仍未验证**：安卓端（其他成员的设备）没单独跑过；锁屏界面上的媒体控制按钮
没有单独确认（"锁屏后还能继续听"已验，那是两件事）。

---

## 文档地图

| 文件 | 给谁看 | 内容 |
|------|--------|------|
| `docs/spec.md` | 想搞懂设计的人 | 决策记录（D1–D10，以及实现后推翻原决策的变更 §1.2）、架构、数据模型、同步算法、WS 协议、HTTP API、免费额度核算 |
| `docs/security.md` | 改代码前**必读** | 威胁模型、逐条对策（以及每条防不住什么）、安全回归清单、上线前检查清单 |
| `docs/superpowers/specs/` | 想搞懂某个特性怎么设计的 | 特性级设计规格（3D 舞台） |
| `docs/superpowers/plans/` | 想追溯怎么做的 | 逐任务的实现计划与验收步骤 |
| `AGENTS.md` | AI agent | 稳定约定与安全红线（压缩版） |
| `memory/progress.md` | 接手的人 | 进展、未完成事项、踩过的坑 |

## 目录结构

```
src/shared/    前后端共用，只能是纯函数与类型（房间码、播放锚点、协议、主题白名单）
src/server/    Worker 侧（路由、鉴权、安全闸门、RoomDO、R2 读写）
src/client/    浏览器侧（Preact + signals、播放器、缓存、聊天）
scripts/       开发辅助（dev-lan：局域网直连启动器）
test/unit/     跑在 node
test/integration/  跑在 workerd
test/e2e/      Playwright
spike/         真机能力验证页（一次性）
```

## 一条设计上的取舍

音频**不做**实时推流，而是"上传 → 云端中转 → 各自播放本地副本"。
这样不需要 WebRTC、不需要时钟对齐、断网也能继续听，代价是换歌时要等上传完成。
理由记在 `docs/spec.md` §1 的决策记录（以及实现之后推翻原决策的变更 §1.2）。

服务端只服务**私密房间**：房间码是唯一入口，文件路径是不可猜的 UUID，
不提供任何"公开分享"能力。这是不让事情变质的唯一关键约束。
