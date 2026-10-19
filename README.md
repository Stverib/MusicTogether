# MusicTogether

![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![Node](https://img.shields.io/badge/node-%3E%3D22.12-339933)

一起听同一首歌，进度条保持同步。

MusicTogether 是一个可自托管的同步听歌 Web 应用。房间里的每个人都能上传歌曲、
控制播放，所有人的进度条由服务端锚点保持一致（±1 秒）。纯网页 / PWA，
浏览器直达，不需要安装客户端。

音频不做实时推流：歌曲上传一次，经对象存储中转，各端播放自己的副本，
同步的只是时间轴与播放状态。这样既不需要 WebRTC，也不需要时钟对齐。

## 功能

- **房间与邀请**：6 位房间码，或分享链接点开即进
- **上传**：桌面浏览器可选目录，手机可选文件
- **共享队列**：所有人可见，可加歌、移除、调序
- **平权控制**：任何人都能播放、暂停、切歌、拖动进度
- **服务端权威同步**：播放锚点由服务端盖时间戳后广播
- **本地缓存**：播放过的文件存入 IndexedDB，下次优先读本地
- **内置聊天**：房间内文字聊天，消息持久化，可向上翻历史
- **断线重连**：WebSocket 指数退避重连，重连后拉取完整快照
- **多人**：成员列表显示在线 / 离开状态
- **3D 舞台**：全屏场景与两个主题，见下
- **PWA**：可安装，支持锁屏媒体控制

## 3D 舞台

进房间后整个页面背后是一块全屏 3D 场景，界面变成浮在上面的磨砂玻璃面板。
房间中央一台黑胶唱片机，播放时缓缓转动；低音与高音分频驱动周围的粒子与灯光。

两个主题，**房间级、谁都能切**（跟播放/暂停一样平权），两边一起过渡：

| 主题 | 样子 |
| ---- | ---- |
| 晨光 | 粉白底、浅橙光、淡墨绿对比色，细小的光点缓慢漂浮 |
| 余烬 | 深底暖橙，中央一颗发光扭曲线框球，光晕随低音起伏 |

**它绝不会弄坏播放。** 三条降级路径，任何一条生效都只是「没有场景」，
其余功能照常：

1. 拿不到 WebGL context（老设备、驱动被禁）→ 不挂载
2. `three` 的 chunk 拉不下来（网络）→ 不挂载
3. 运行期抛异常 → 卸载并安静收场

律动数据有三层：主路用 `captureStream()` 从旁边接一路音频出来分析
（**不重路由** `audio` 元素的输出）；备路 `createMediaElementSource()`；
拿不到任何频域数据就用一条程序化曲线兜底。**音频能量只在本地计算，绝不上行。**

手机上会按实测帧时间**自动降画质**（只降不升，档位记在本地，不上行）。
`prefers-reduced-motion: reduce` 时渲染静态场景，唱片不转。
首屏不背 `three`：**整棵场景树**（stage + 画质 + 律动 + 主题）是一个独立的
5.6 KB chunk，进房间之后才按需加载；`three` 另在 736 KB 的 chunk 里。
首屏只多 **1.7 KB**（42,798 → 44,577 B）。

## 架构

单个 Cloudflare Worker 同时托管静态 SPA 与 `/api/*`。每个房间是一个
SQLite 后端的 Durable Object，用 WebSocket Hibernation 维持长连接，
并广播服务端权威的播放锚点。音频字节存 R2，经 Worker 代理以支持 Range 与鉴权。

```
浏览器 A ──┐                        ┌─ 静态 SPA
           ├── HTTPS / WSS ── Worker ┼─ /api/*
浏览器 B ──┘                        └─ HMAC 会话
                                       │
                            ┌──────────┴──────────┐
                            │                     │
                     Durable Object            R2
                     （每个房间一个）        （音频字节）
```

## 快速开始

需要 Node **22.12+**（wrangler 要求 ≥ 22，Vite 要求 ≥ 22.12）。

```bash
npm install
cp .dev.vars.example .dev.vars
# 编辑 .dev.vars：SESSION_SECRET 至少 32 个字符
```

开发模式需要两个终端：

```bash
npm run dev:worker   # Worker + API，监听 8787
npm run dev          # Vite 前端，监听 5173，/api 代理到 8787
```

然后打开 [http://localhost:5173](http://localhost:5173)。要模拟两个用户，
使用无痕窗口 —— 身份保存在 `localStorage` 中，同一浏览器 profile 的普通窗口
会共用一个身份。

> `.dev.vars` 只用于本地开发，已在 `.gitignore` 中。
> 生产密钥通过 `wrangler secret put SESSION_SECRET` 注入，不要提交到仓库。

## 局域网 / 多设备调试

```bash
npm run dev:lan
```

该命令会构建前端、绑定 `0.0.0.0:8787`，并打印可访问的局域网地址。
用另一台设备打开打印出来的地址即可。

调试时注意：

- **分享链接按 `location.origin` 生成。** 从 `localhost` 进入时生成的链接
  在另一台设备上打不开，所以调试分享功能时也要从局域网地址进入。
- 部分访客网络启用了客户端隔离（AP isolation），设备之间无法互访。
- 明文 HTTP 不是安全上下文：Service Worker、PWA 安装、离线能力不可用，
  剪贴板等 API 会走降级路径。
- 服务监听所有网卡，同一网段的人都能访问。调试结束后及时停止。

## 测试

```bash
npm run typecheck       # 前端与服务端两套 tsconfig
npm test                # 单元 + 集成（真实 workerd + Durable Object + R2 模拟）
npm run test:e2e        # Playwright，跑构建产物，起在 8788
```

当前覆盖：单元 + 集成 208 条、端到端 59 条，全部通过。

E2E 使用系统 Edge（`channel: 'msedge'`），不下载 Playwright 自带浏览器。
`.dev.vars` 中的 `RATE_LIMIT_SCALE` 是给本地与 E2E 用的限速逃生口 ——
本地所有请求都来自同一个 IP，不放宽的话测试套件会把自己挡住；
集成测试那一层显式把它锁回 1，所以限速本身仍然是被测对象。

E2E 的本地状态放在 `.wrangler/e2e-state`，每轮开跑前清空，与
`npm run dev:worker` 使用的 `.wrangler/state` 完全隔离。测试不会影响开发中的
房间和歌曲，测试之间也不会互相带脏数据。

## 部署

需要一个 Cloudflare 账号。首次部署：

```bash
npx wrangler login
npx wrangler r2 bucket create musictogether-tracks
npx wrangler secret put SESSION_SECRET      # 32 字节以上的随机值
npm run deploy
```

如果 R2 桶名不是 `musictogether-tracks`，同步修改 `wrangler.jsonc`。
`SESSION_SECRET` 必须是足够长的随机值，否则服务会拒绝启动。

上线前请逐条过 `docs/security.md` §5 的检查清单。生产环境必须使用 HTTPS：
PWA、Service Worker 与安全上下文相关的 Web API 都依赖它。

## 浏览器兼容性

- **桌面 Chrome / Edge**：完整支持，可使用目录选择 API
- **HarmonyOS 浏览器（ArkWeb）**：已验证音频播放、seek、文件夹选择、
  锁屏与切后台后继续播放
- **Android**：已验证可正常访问与播放
- **PWA 安装与 Service Worker**：需要 HTTPS

## 项目结构

```
src/shared/        前后端共用，只能是纯函数与类型（房间码、播放锚点、协议、主题白名单）
src/server/        Worker 侧（路由、鉴权、安全闸门、RoomDO、R2 读写）
src/client/        浏览器侧（Preact + signals、播放器、缓存、聊天）
  stage/           3D 场景层，独立于 Preact 的命令式模块，整棵按需加载
    themes/        主题实现（晨光、余烬）+ 注册表
scripts/           开发辅助脚本
test/unit/         跑在 node
test/integration/  跑在 workerd
test/e2e/          Playwright
spike/             真机能力验证页（一次性）
```

## 文档

| 文件 | 内容 |
| ---- | ---- |
| `docs/spec.md` | 决策记录、架构、数据模型、同步算法、WebSocket 协议、HTTP API |
| `docs/security.md` | 威胁模型、逐条对策、安全回归清单、上线前检查清单 |
| `docs/superpowers/specs/` | 特性级设计规格（3D 舞台） |
| `docs/superpowers/plans/` | 逐任务的实现计划与验收步骤 |
| `AGENTS.md` | 项目约定与安全红线 |
| `memory/progress.md` | 开发进展、踩过的坑 |

## 安全

项目按私密房间设计：房间码是唯一入口，曲目路径使用不可猜的 UUID，
不提供公开房间或公开分享。上传内容经过类型与体积校验，流式响应使用白名单
`Content-Type` 与 `nosniff`，WebSocket 升级校验 `Origin`，所有房间路由都会
校验会话中的房间码与路径一致。

完整威胁模型与逐条对策见 `docs/security.md`。修改安全相关代码前，
请先阅读 `AGENTS.md` 的「安全红线」。

## 贡献

欢迎提交 Issue 与 Pull Request。改动前请：

1. 阅读 `AGENTS.md`，尤其是「安全红线」
2. 为新行为补充测试
3. 确保 `npm run typecheck` 与 `npm test` 通过

运行时依赖保持精简：新增依赖需要有明确理由。

## License

[MIT](LICENSE)
