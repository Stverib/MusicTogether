# MusicTogether — 项目约定

和别人一起听同一首歌，进度条保持同步。纯网页 / PWA，跑在 Cloudflare 上。

> 面向人的入口在 `README.md`。完整设计见 `docs/spec.md`，安全威胁模型见
> `docs/security.md`，实现计划见 `docs/superpowers/plans/`。
> 本文件只放稳定约定与红线。

---

## 常用命令

    npm run dev            # 前端开发服务器（Vite，5173，/api 代理到 8787）
    npm run dev:worker     # 本地 Worker（wrangler，8787，只绑 localhost）
    npm run dev:lan        # 局域网/局域网直连：绑 0.0.0.0 并打印可分享的地址
    npm test               # 单元 + 集成测试
    npm run test:e2e       # Playwright（跑构建产物，8788；用系统 Edge）
    npm run typecheck      # 前端与服务端两套 tsconfig 都检查
    npm run deploy         # 构建并部署

新克隆的仓库跑不了 Worker：`.dev.vars` 被 gitignore 了，
要照 `.dev.vars.example` 自己建一个（`SESSION_SECRET` 必须 32 字符以上，
否则服务会拒绝启动）。

首次部署前必须：

    wrangler r2 bucket create musictogether-tracks
    wrangler secret put SESSION_SECRET

## 架构一句话

单个 Worker 同时托管静态 SPA 与 `/api/*`；每个房间是一个 SQLite 后端的
Durable Object，用 WebSocket Hibernation 维持长连接并广播服务端权威的播放锚点；
音频字节存 R2，经 Worker 代理以支持 Range 与鉴权。

## 目录约定

- `src/shared/` —— 前后端共用，**只能是纯函数与类型**，不得 import DOM 或 Workers API
- `src/server/` —— Worker 侧
- `src/client/` —— 浏览器侧
- `scripts/` —— 开发辅助脚本（`dev-lan.mjs`：局域网直连启动器）
- `test/unit/` 跑在 node；`test/integration/` 跑在 workerd；`test/e2e/` 用 Playwright

---

## 安全红线

违反其中任何一条，代码不予合并。

### 输入与输出

1. **所有从 URL 来的路径片段必须先做格式校验再拼进任何 key。**
   `trackId` 必须是严格的 UUID（`/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/`），
   房间码必须过 `isValidCode()`。否则 `../../` 就能读到别的房间的文件。

2. **绝不 `innerHTML` / `dangerouslySetInnerHTML` / `eval` / `new Function`。**
   聊天内容、文件名、昵称全部是攻击者可控的。Preact 默认转义，保持这个默认。

3. **响应的 `Content-Type` 绝不回显用户提供的值。**
   上传时客户端声明的 MIME 只用于存储元数据；出站时一律由扩展名映射到白名单内的
   音频类型，配 `X-Content-Type-Options: nosniff`。
   否则攻击者上传一个 HTML 文件，受害者直接访问流地址就会执行脚本。

4. **所有写操作的请求体都要做类型与范围校验**，不能信任 `Content-Length`
   （可以伪造或省略）—— 体积限制必须在流式读取时累计计数。

### 鉴权与授权

5. **每个房间路由都必须校验 `session.room === 路径里的房间码`。**
   会话是无状态 HMAC，签名对了不代表有权访问这个房间。

6. **WebSocket 升级必须校验 `Origin` 与部署域名一致。**
   WebSocket 不受同源策略与 SameSite 保护，是 CSRF 的现成通道。

7. **不设置任何 CORS 响应头。** 不要开 `Access-Control-Allow-Origin`。

8. **删除云端文件只允许上传者本人。** 移出队列是平权的，删除不是。

### 密钥与凭据

9. **`SESSION_SECRET` 只经 `wrangler secret` 注入，绝不写进仓库。**
   `.dev.vars`、`.env` 已在 `.gitignore` 里，不要绕过。

10. **日志里不打令牌、签名、Cookie 内容。** 出错时只记状态码与路径。

### 资源

11. **上传与建房的入口必须限速。** 房间码有 32⁶ ≈ 10.7 亿种，只有配上限速
    才谈得上不可枚举。

12. **每个房间有存储配额**（曲目数与总字节数），满了拒绝上传。
    否则任何人拿到一个房间码就能把 R2 免费额度填满。

### 依赖

13. **新增运行时依赖需要理由。** 当前运行时依赖是 `preact`、`@preact/signals`
    与 `three`（3D 舞台，MIT、ESM、核心 0 处 `eval`/`new Function`，所以 CSP
    一行都不用改）。大多数需求用标准 Web API 就够了 —— `three` 是特例，不是先例。

### 响应头与静态外壳

14. **CSP 有两份，必须逐字符一致。** API 的在 `src/server/security.ts` 的 `CSP`，
    静态外壳（不走 Worker）的在 `src/client/public/_headers`。
    `test/e2e/security.spec.ts` 有一条用例直接比对两者，改一处漏另一处会红。

15. **`index.html` 里不能有任何内联 `<script>`。** `script-src` 没有
    `unsafe-inline`，内联脚本会被静默挡掉（Service Worker 就是这么失效过一次）。
    需要启动代码就写进 `main.tsx`。同理，绝不给 CSP 开 `unsafe-inline`。

---

## 提交约定

**每完成一次小的阶段性任务就立刻提交一次。** 这不是"最后一起提交"，
而是每走完一小步就落一个 commit —— 一个任务、一个可独立验证的改动、
一次红灯转绿、一次文档更新，都算一步。

具体要求：

- 格式：Conventional Commits，**英文**
- 粒度：宁可多提交，不要攒成一个大提交。一个提交只做一件事
- 提交前跑一次相关测试；带着红灯提交时，提交信息里要写明（例如 `wip:` 前缀）
- 提交信息写"为什么"，不写"改了什么"——`git diff` 已经说明了改了什么

## 待办红线（实现中必须守住，容易忘）

- Durable Object **必须**用 `new_sqlite_classes`（免费计划只支持 SQLite 后端）
- WebSocket **必须**用 Hibernation API；`ping`/`pong` **必须**走 `setWebSocketAutoResponse`
- R2 响应**必须**流式转发，`206` 与 `Content-Range` **必须**手写
- 客户端**必须**每 25 秒心跳（空闲超时存在但时长未公开）
- 兜底同步帧**只在播放中**调度，暂停时必须取消 alarm
- 3D 场景的**音频能量只在本地算，绝不上行**；`three` 必须按需加载
  （整棵场景树一个 chunk），首屏不许背上它
- 律动分析的**备路 `createMediaElementSource()` 不可撤销**，销毁时必须把
  `source → destination` 重新接上，否则整首歌永久静音
- Service Worker 的预缓存清单**不能**写死带哈希的 JS/CSS 文件名 ——
  `addAll` 会因为 404 整体失败，SW 静默装不上（离线与"添加到主屏幕"一起失效）。
  外壳资源由 fetch 处理器在首次成功请求时顺手缓存
