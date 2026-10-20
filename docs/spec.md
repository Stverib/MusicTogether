# MusicTogether 设计规格

> 一句话：两个人（或多人）在各自的浏览器里打开同一个网页，A 把自己设备上的歌传上去，所有人听到同一首歌，进度条保持同步。

状态：**已实现**（2026-10-18 起按 `docs/superpowers/plans/2026-10-18-musictogether-mvp.md`
逐任务落地；3D 舞台见 `docs/superpowers/plans/2026-10-18-3d-stage.md`）。
测试与部署方式见根目录 `README.md`。HarmonyOS 与 Android 真机均验证通过。

### 实现过程中与规格的偏差

规格没写到、写代码时才暴露出来的地方，按实际实现为准：

1. **曲目入队的时机**：登记（`POST /tracks`）时**不**入队，等字节真的落进 R2
   之后由服务端入队。原设计隐含"登记即可见"，但那样另一端点播放只会拿到 404 ——
   大文件下这个窗口能有几分钟。现在队列里的每一首都保证能播。
2. **静态外壳的安全响应头**：静态资源由平台直接送出（`run_worker_first: ["/api/*"]`，
   为了不把静态资源算进 Worker 请求额度），所以它的 CSP 等头写在
   `src/client/public/_headers`，与 `src/server/security.ts` 里的那份是两处。
   端到端有一条用例比对两者逐字符相同。
3. **`index.html` 里不能有内联脚本**：`script-src` 没有 `unsafe-inline`，
   Service Worker 的注册因此挪进了 `main.tsx`。
4. **Service Worker 的预缓存清单**不能写死带内容哈希的 JS/CSS 文件名，
   否则 `addAll` 因 404 整体失败、SW 静默装不上。改为运行时顺手缓存。
5. **`RATE_LIMIT_SCALE`**：仅本地与 E2E 用的限速倍率逃生口（生产不设该变量）。
   本地所有请求来自同一个 IP，不放宽的话测试套件会把自己挡住。
6. **3D 舞台的 `three` 拆成独立 chunk**，进房间之后才动态加载。Vite 8 走
   rolldown，`manualChunks` 的对象形式直接报错，`advancedChunks` 也已废弃，
   所以用的是 `codeSplitting.groups`。首屏只多 1.7 KB。
7. **律动数据绝不上行**。主路用 `audio.captureStream()` 从旁边接一路出来分析，
   **不重路由** `audio` 元素的输出；备路 `createMediaElementSource()` 不可撤销，
   所以销毁时必须让 source 直连 destination，否则整首歌永久静音。
8. **主题是房间级状态**，落进 `RoomState` 并走 WebSocket 广播；画质档位相反，
   只存在设备本地，不上行。两者不要混。
9. **`Member.away` 是客户端上报的**（`visibilitychange`）。最小化窗口、切到别的
   应用都不会断开 WebSocket，光看连接状态看不出人已经走了。见 §1.2 的 D13。

---

## 1. 决策记录

以下每一条都在实现前逐条确认过，不是推断。

| # | 决策点 | 结论 |
|---|--------|------|
| D1 | 音源模型 | A 上传 → 云端中转 → B 下载成缓存 → 各自播放本地副本，同步的是时间轴与播放状态。**不是**实时音频推流。 |
| D2 | 交付形态 | 纯网页 / PWA。一套代码同时跑 HarmonyOS 与 Android，浏览器直达，不经过任何应用商店。 |
| D3 | 服务端 | Cloudflare Serverless 全家桶：Workers（API/静态资源）+ Durable Objects（房间）+ R2（文件）。 |
| D4 | 播放控制权 | 平权 + 服务端权威。任何人都能播/停/切/拖，操作发给服务端，服务端盖时间戳后广播。 |
| D5 | 同步精度 | 粗同步（±1 秒即可）。不做时钟对齐、不做变速追帧。 |
| D6 | 播放源 | 流式播放 + 后台缓存。B 直接从 R2 拉流即点即响；同时后台把文件写进本地缓存，下次走本地。 |
| D7 | 房间生命周期 | 常驻 + 可临时开房。配对一次后记住房间，以后打开就在里面；也可临时开一个。 |
| D8 | 上传端 | 电脑与手机都支持。电脑用目录选择 API（体验好），手机退化为选文件夹或多选。 |
| D9 | 云端副本 | 永久保留。「从队列移除」不影响云端；另有明确的「从云端彻底删除」。 |
| D10 | 第一版范围 | 基本闭环（配对/上传/队列/同步）+ 本地缓存与删除 + 内置聊天 + 断线重连 + 多人支持，全做。 |

### 1.1 由决策推导出的约定

- **共享队列**：房间里一个队列，任何人可加歌、移除、调序。
- **无账号系统**：身份靠 `localStorage` 里的 `clientId` + 用户自填昵称，没有注册登录。
- **房间码为 6 位字母数字**（见 §4.1），不是 6 位纯数字——后者只有 100 万种可能，可被枚举。
- **不解析 ID3 标签**：列表直接显示文件名。若日后需要，再引入元数据解析。
- **歌曲文件经 Worker 代理提供**，不开放 R2 公开桶，以保证链接不可被外部猜测访问。

### 1.2 实现之后的决策变更

以下三条是 2026-10-18 实现完成、用户实际用过之后改的。**它们推翻了上面的原决策**，
记在这里而不是悄悄改掉——原决策是逐条确认过的，变更本身也需要留痕。

| # | 决策点 | 原结论 | 新结论 | 为什么改 |
|---|--------|--------|--------|----------|
| D11 | 成员离线后的去留 | 断开即从成员列表移除 | **保留在列表里，标 `online: false`** | "已离开"这个状态在原设计里根本不存在。一起听歌时看得见其他成员刚走，比看得见他凭空消失更像一个房间 |
| D12 | 聊天是否落库 | **不落库**，只广播给在线成员，重连后看不到历史 | **落库，全部保留** | 用过之后发现"聊天记录一刷新就没了"是真的难受 |
| D13 | "在线"的判据 | 连接还在（WebSocket 未断开） | **连接还在且页面在前台**，另加一个客户端上报的 `away` | 最小化窗口、切到别的应用、手机按 home 都**不会**断开 WebSocket。只看连接状态的话，人明明走了，点还是绿的 |

D11、D12 与 D13 的实现细节：

- **D11**：同一 `clientId` 重连翻回在线，不新增成员。列表上限 20 人，
  **只淘汰离线的最老的**——否则第三十一个人进来会把正在听歌的人踢出列表。
- **D12**：聊天**不放进 `RoomState`**，单独用一个存储键。原因是 `RoomState`
  每次播放/暂停/切歌都会整个 `save()` 一遍，聊天并进去的话每次点暂停都要把
  整份聊天记录重写一次存储，而它只会越来越大。快照只带**最近 200 条**——
  WebSocket 单帧有 1 MiB 上限，全量序列化迟早会撞上去，那是硬失败。
  更早的走 `GET /api/rooms/:code/chat?before=<id>` 按需取。
- **D13**：`Member` 因此有两个标志，不是一个。`online` 是"连接还在"，
  `away` 是"页面不在前台"，由客户端在 `visibilitychange` 时经
  `{ type: 'presence', away }` 上报。**两者都假**才是界面上那个灰点。
  重连时服务端把 `away` 翻回 false（连接还在就说明页面活着），
  客户端在 `onopen` 立刻补报一次真实值，所以后台重连不会停在错的状态上。
  上报是**幂等**的：真机上可见性事件会成串地来，重复上报不产生广播。
  服务端只收布尔值——`away: "yes"` 这种隐式真值一律拒掉。

---

## 2. 方案的地基假设 —— 2026-10-18 真机验证通过 ✅

这三条是整个方案的地基。任何一条不成立，D2（纯网页）就要重新评估。

**结论：三条全部通过。** 在 HarmonyOS 手机真机上（与开发机同一局域网）打开
`spike/verify.html` 逐项验证，R1 / R1b / R2 / R3 均正常。纯网页方案成立，
D2 无需重新评估。

| # | 假设 | 不成立时的后果 | 验证结果 |
|---|------|----------------|----------|
| R1 | 华为浏览器（ArkWeb）能正常播放 `<audio>`，能 seek，能响应 `timeupdate` | 鸿蒙端完全不可用 | ✅ 通过 |
| R2 | 华为浏览器支持 `<input type="file" webkitdirectory>`，能选到手机音乐目录 | 降级为逐首多选（可用但难用） | ✅ 通过 |
| R3 | 锁屏 / 切后台后音频继续播放，WebSocket 不被掐断 | 同步失效，需退回"下完再听"模式并接受后台即断 | ✅ 通过 |

验证页（`spike/verify.html`）把 R1 拆成两步：R1 用代码生成的测试音，
R1b 用一首真实的 mp3 —— 合成音能播不代表真实编码的歌曲能播。

**Android 端也已验证**（2026-10-20）：可正常访问与播放。

**完整流程另有一次真机验收**（2026-10-18）：手机（HarmonyOS 浏览器）经局域网地址
连到开发机上跑的 `wrangler dev`，**手机上传**一首歌，两台设备都能听到，
成员列表正确。这一轮覆盖了 D8 的移动端上传路径与真机上的实际播放，
并且实测**两端秒级同步**（满足 D5 的 ±1 秒）、**锁屏与切后台后音频继续播放**
（R3 在完整应用里复现，不只是验证页）。

**PWA 安装不在这一轮里** —— 局域网 HTTP 不是安全上下文，Service Worker
注册不了。要验证它需要 HTTPS：正式部署，或用 `cloudflared tunnel` 把本地
dev server 临时暴露成 HTTPS。

原「待确认」两项（Durable Objects 免费额度、请求体上限）**已核实通过**，见 §12。核实过程中发现了三条**会改变实现方式**的硬约束，已并入下方各节：

- WebSocket 消息计入 DO 的 100,000 次/日免费额度 → **协议必须"只在状态变化时说话"**，禁止高频进度广播
- WebSocket 空闲超时存在但时长未公开 → **必须实现客户端心跳**
- Worker 内存 128 MB → **R2 响应必须流式转发，不能缓冲**

另外，`getWebSocket` 相关的两个行为已由 Cloudflare 在 2026 年 3 月和 4 月改为默认，新建 Worker 直接受益，见 §6.3。

---

## 3. 用户流程

### 3.1 首次配对

**走分享链接（推荐）**

1. A 打开网页 → 「创建一个房间」→ 得到房间码（如 `K7M2QX`）
2. A 点「分享」→ 手机上弹系统分享面板（微信/QQ 都在里面），
   桌面上把 `/r/K7M2QX` 复制到剪贴板
3. B 点开链接 → 房间码已经填好，只差一个昵称 → 进房
   （B 之前用过的话，连昵称都不用填，点开就在房间里了）
4. A 加入成功后地址栏立刻还原成 `/`，房间码不再挂在历史和截图里
   （见 `docs/security.md` §2.10）

**人肉念码**

B 打开同一网址 → 手输码 + 昵称 → 进房。输入框会边打边归一化，
大小写与分隔符都不影响（`k-7-m-2-q-x` 会变成 `K7M2QX`）。

两条路都靠 `localStorage` 记住房间码，之后打开直接进。

**为什么把码放进 URL**：房间码本来就是唯一的秘密，"把链接给对方"就是
"把秘密给对方"，这正是邀请的语义。取舍与缓解写在 `docs/security.md` §2.10。

### 3.2 听歌

1. A 点「添加歌曲」→ 选文件/文件夹 → 勾选要传的 → 上传
2. 队列里出现这些歌（所有人可见）
3. 任何人点某首歌 → 服务端记录锚点并广播 → 所有人开始播放
4. 任何人拖进度条 / 暂停 / 切歌 → 服务端盖时间戳广播 → 所有人跟随
5. B 的浏览器在后台把播过的文件存进 IndexedDB

### 3.3 管理

- 「缓存」面板：看占用、逐首删除、全部清空
- 队列项：「从队列移除」（云端保留） / 「从云端彻底删除」（仅上传者可见）
- 「临时开房」：生成一个新的临时房间码，用完可销毁

---

## 4. 架构

```
┌──────────────┐        HTTPS / WSS        ┌─────────────────────────┐
│  浏览器 A     │ ◄───────────────────────► │  Cloudflare Worker       │
│  (PWA)       │                            │  ├─ 静态资源 (SPA)        │
└──────────────┘                            │  ├─ /api/rooms/*  路由    │
                                            │  └─ HMAC 会话校验         │
┌──────────────┐                            └───────┬─────────┬───────┘
│  浏览器 B     │ ◄───────────────────────►         │         │
│  (PWA)       │                              ┌─────▼─────┐ ┌─▼─────┐
└──────────────┘                              │ Durable   │ │  R2   │
                                              │ Object    │ │ 文件  │
                                              │ = 一个房间 │ │       │
                                              └───────────┘ └───────┘
```

**为什么 Durable Object 天然合适**：一个 DO 实例 = 一个房间。它天生是单点，所以"服务端权威"不需要任何分布式协调。WebSocket Hibernation API 让空闲房间不产生计费时长。

### 4.1 房间码

- Crockford Base32 字母表：`0123456789ABCDEFGHJKMNPQRSTVWXYZ`
  （32 字符 = 10 个数字 + 去掉 `I L O U` 的 22 个字母。`0` 与 `1` **在**字母表里，
  被剔掉的是和它们长得像的 `O` 与 `I`/`L`）
- 长度 6 → 32⁶ ≈ 10.7 亿种组合
- 输入边打边归一化（`normalizeCode()`）：转大写 → 丢掉非字母数字 →
  `O`→`0`、`I`/`L`→`1`、`U`→`V`。所以 `k-7-m-2-q-x` 会变成 `K7M2QX`，
  大小写与分隔符都不影响，粘贴也不该被截断

### 4.2 鉴权

无账号。流程：

1. `POST /api/rooms/:code/join` `{name, clientId?}` → 服务端确认房间存在（或创建）→ 签发 HMAC 签名令牌
2. 令牌内容：`{room, clientId, name, exp}`，`exp` = 30 天（对应"常驻房间"）
3. 以 Cookie 形式下发：`mt_sess`，`HttpOnly; Secure; SameSite=Lax; Path=/`
4. `<audio>` 元素的请求会自动带上 Cookie —— 这是选 Cookie 而非 Authorization 头的**唯一原因**

**已知取舍**：令牌是无状态的，**无法吊销**，只能等过期。v1 接受；房间码本身就是真正的秘密。

### 4.3 存储布局

```
R2:  rooms/<roomCode>/tracks/<trackId>          # trackId 为 UUID，不可猜
DO:  房间状态（见 §5）
```

---

## 5. 数据模型

### 5.1 Durable Object 状态

```ts
type Track = {
  id: string;          // UUID
  name: string;        // 原始文件名
  size: number;
  mime: string;
  uploaderId: string;
  uploaderName: string;
  addedAt: number;
};

type Member = {
  clientId: string;
  name: string;
  joinedAt: number;
  /** 断开连接后不从列表里删掉，只翻成 false（决策 D11） */
  online: boolean;
  /** 页面不在前台（决策 D13）。客户端上报，与 online 是两件事 */
  away: boolean;
};

type Playback = {
  trackId: string | null;
  positionMs: number;      // 锚点位置
  anchorAt: number;        // 该位置对应的服务端时刻 (ms)
  isPlaying: boolean;
  seq: number;             // 单调递增，用于丢弃乱序消息
};

type RoomState = {
  code: string;
  name: string;
  createdAt: number;
  members: Member[];
  tracks: Track[];
  queue: string[];         // trackId 有序数组
  playback: Playback;
  epoch: number;           // 结构性变更（队列/曲目）的版本号
};
```

**存储后端必须是 SQLite**：Workers 免费计划只提供 SQLite 后端的 Durable Object（KV 后端是历史遗留，新账号不可用）。用 `wrangler` 的 `new_sqlite_classes` 迁移声明。

**房间状态只存元数据**，音频字节一律在 R2。因此 DO 的存储占用是 KB 级，与 §12 中那处「每对象 1 GB 还是 10 GB」的官方文档矛盾无关。

### 5.2 同步算法（D5：±1 秒）

服务端只存**锚点**，不存"当前进度"：

```
currentPosition(now) = isPlaying ? positionMs + (now - anchorAt) : positionMs
```

- **状态变化时**（play / pause / seek / 切歌）：`anchorAt = serverNow`，`positionMs = 新位置`，`seq++`，广播给全房间（含发起者）
- **周期性兜底**：每 30 秒广播一次带 `serverNow` 的同步帧
- **客户端校正**：收到同步帧后算 `target = positionMs + (serverNow - anchorAt)`；`|audio.currentTime - target| > 2000ms` 才 `seek`（避免频繁 seek 产生爆音）。**起播时**（`playing` 事件）用 500ms 的更紧阈值再对齐一次 —— 起播本身可能比锚点晚一秒以上，2 秒的周期阈值会把这个延迟固化成偏差
- **不做网络延迟补偿**：WebSocket 没有 RTT 测量，拿相邻两帧的间隔去猜会引入系统性偏差（实测能到 1–2 秒）。局域网的单程延迟远小于 ±1 秒的目标，直接用服务端 `serverNow` 更稳

**为什么这样够用**：`<audio>` 的播放速率由声卡晶振决定（±50 ppm），两端从同一位置同时起播后，一首 4 分钟的歌累计漂移也只有几十毫秒。唯一需要校正的是初始 seek 的误差与中途加入的偏差。所以**不需要时钟对齐、不需要变速追帧**。

---

## 6. WebSocket 协议

单个端点 `/api/rooms/:code/ws`（Upgrade）。所有消息为 JSON，`type` 字段判别。

### 6.1 客户端 → 服务端

| type | 载荷 | 说明 |
|------|------|------|
| `hello` | `{name}` | 连接后第一帧，用于改名 |
| `play` | `{trackId}` | 从该曲目 0 位置开始播 |
| `resume` | `{}` | 从当前位置继续 |
| `pause` | `{}` | 在当前位置暂停 |
| `seek` | `{positionMs}` | 跳转 |
| `next` / `prev` | `{}` | 切歌 |
| `enqueue` | `{trackId}` | 加入队列 |
| `dequeue` | `{trackId}` | 从队列移除 |
| `reorder` | `{queue: string[]}` | 重排队列 |
| `chat` | `{text}` | 聊天（≤ 500 字） |
| `presence` | `{away: boolean}` | 页面是否在前台（决策 D13）。幂等，重复上报不广播 |
| `theme` | `{theme}` | 换房间主题。必须过 `isThemeId()` 白名单，同值幂等 |
| `ping` | `{}` | 保活 |

### 6.2 服务端 → 客户端

| type | 载荷 | 说明 |
|------|------|------|
| `state` | `{room, chat, chatTotal, serverNow}` | 连接/重连后的完整快照。`chat` 只带最近 `CHAT_HISTORY_PAGE`（200）条，`chatTotal` 是总数 |
| `playback` | `{playback, serverNow}` | 锚点变化 |
| `sync` | `{playback, serverNow}` | 30 秒兜底同步帧（同结构，语义不同） |
| `queue` | `{queue, epoch}` | 队列变化 |
| `tracks` | `{tracks, epoch}` | 曲目表变化 |
| `members` | `{members}` | 成员变化（在线/离开、主题无关） |
| `chat` | `ChatMessage` | 聊天消息（**已落库**，决策 D12） |
| `theme` | `{theme}` | 房间主题变化 |
| `error` | `{message}` | |

**每一帧带播放状态的都**必须**带 `serverNow`**：客户端要拿它把锚点换算成
"现在应该播到哪儿"。`state` 快照漏掉它会很难查 —— 中途进房的人位置是对的，
但要干等到下一次兜底同步帧（最多 30 秒）才出声。

**聊天会落库**（决策 D12，推翻了原来的"不落库"）：消息存在 DO 的独立存储键里，
一条不删；`state` 快照只带最近 `CHAT_HISTORY_PAGE`（200）条，
更早的走 `GET /api/rooms/:code/chat?before=<id>` 按需取。
快照不带全量的原因是硬的：WebSocket 单帧有 1 MiB 上限。

### 6.3 连接保活与额度纪律

Cloudflare 会在一段**未公开的**空闲时长后掐断 WebSocket，且网络更新时也会断开。因此：

- **必须用 WebSocket Hibernation API**（`state.acceptWebSocket()` / `webSocketMessage()` 处理器形式），空闲房间不产生计费时长
- **必须用 `setWebSocketAutoResponse`** 处理应用层 ping/pong，这类往返不会唤醒 DO
- **客户端每 25 秒发一次 `ping`** 作为保活

**协议纪律（免费额度的生命线）**：WebSocket 消息**计入** DO 的 100,000 次/日请求额度。因此**绝不做"每秒广播进度"**。位置由客户端根据锚点自行推算，服务端只在状态**变化**时说话。

**30 秒兜底同步帧只在播放中才调度**：用 `state.storage.setAlarm()` 定时，暂停时取消。暂停状态下没有任何周期性消息。

粗算：两个人在线听 4 小时，心跳 2 × (14400 / 25) = 1,152 条，加状态变化与兜底帧，
一天远在 100,000 以内。

---

## 7. HTTP API

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/health` | 健康检查，返回 `{ok, at}`。`SESSION_SECRET` 没配好时 `ok: false` + 503 —— 宁可整个服务报不健康，也不要带着一个坏密钥跑 |
| `POST` | `/api/rooms` | 创建房间，返回 `{code}` |
| `POST` | `/api/rooms/:code/join` | 加入，返回 `{clientId, room}` 并种 Cookie |
| `GET` | `/api/rooms/:code/state` | 拉取快照（WS 之外的兜底） |
| `GET` | `/api/rooms/:code/chat` | 取更早的聊天历史，`?before=<消息 id>` 为游标；不带游标就是最新一页 |
| `POST` | `/api/rooms/:code/tracks` | 登记元数据，返回 `{trackId, uploadUrl}` |
| `PUT` | `/api/rooms/:code/tracks/:id/blob` | 上传文件字节 → R2 |
| `GET` | `/api/rooms/:code/tracks/:id/stream` | 流式读取，支持 `Range`，返回 206 |
| `DELETE` | `/api/rooms/:code/tracks/:id` | 从云端彻底删除（仅上传者） |
| `GET` | `/api/me` | 返回当前会话身份 |

**`/stream` 的鉴权不查 Durable Object**，只验 HMAC 签名 + 路径中的房间码与令牌一致。原因是浏览器会为一首歌发几十个 Range 请求，每次都查 DO 会把成本放大几十倍。

### 7.1 `/stream` 的实现要点

- 取对象时把请求头直接透传：`env.BUCKET.get(key, { range: request.headers })`
- **必须流式返回 `object.body`，不能 `await object.arrayBuffer()`** —— Worker 内存只有 128 MB，缓冲稍大的文件会直接报 `Memory limit would be exceeded before EOF`
- **R2 的 Worker API 不会自动生成 `206` / `Content-Range`**，Cloudflare 官方示例连 Range 请求都返回 200。这两个头要我们自己按 `object.range` 拼
- `If-Range` 不被 R2 支持（其余条件头都支持）；非法 Range 会得到 R2 错误 `10039`，应转成 `416`
- CPU 时间不含网络 I/O 等待，所以流式转发不会撞上免费计划的 10 ms CPU 上限；代价只是每个请求消耗 1 次 Worker 请求 + 1 次 R2 Class B 操作

---

## 8. 前端结构

- **技术栈**：Vite + TypeScript + Preact + @preact/signals
- **状态**：一个 `RoomStore`，持有服务端快照 + 本地播放器状态，signals 驱动 UI
- **播放器**：`player.ts` 封装 `<audio>`，负责「按服务端锚点起播」与「漂移校正」
- **缓存**：`cache.ts` 用 IndexedDB 存 `trackId → Blob`；播放时优先用本地 Blob URL
- **重连**：WebSocket 指数退避重连；重连成功后服务端下发 `state` 全量快照

### 8.1 选歌（D8）

| 环境 | 手段 |
|------|------|
| 桌面 Chrome/Edge | `showDirectoryPicker()` |
| 手机 / 其他 | `<input type="file" webkitdirectory multiple>` |
| 兜底 | `<input type="file" accept="audio/*" multiple>` |

**与规格的差异**：原计划把目录句柄存进 IndexedDB 以便"下次一键重扫"，没有实现 ——
现在每次都要重新选目录。功能完整，只是多一步。

### 8.2 缓存策略

- 播放一首歌时，后台 `fetch` 全文件 → Blob → IndexedDB
- 首次写入前调用 `navigator.storage.persist()` 申请持久化
- 「缓存」面板显示 `navigator.storage.estimate()` 的用量，支持逐首删除与全部清空
- 播放源选择：有本地缓存 → `URL.createObjectURL`；无 → 网络流 URL

---

## 9. 非目标（明确不做）

- 实时音频推流（D1 已排除）
- 音频指纹匹配（不需要，因为文件是明确传输的，不是猜的）
- 账号、注册、好友关系
- 公有房间广场、公开分享链接
- ID3 / 封面解析
- 精确同步（时钟对齐、变速追帧）
- 原生 App、应用商店分发

---

## 10. 数据与版权

- 服务端只应服务**私密房间**：房间码是唯一入口，文件路径为不可猜的 UUID
- 不提供任何"公开分享"能力——这是不让事情变质的唯一关键约束
- R2 上的副本由上传者显式删除（D9）

**安全设计另见 `docs/security.md`**（威胁模型、逐条对策、以及每条对策防不住什么）。
`AGENTS.md` 的「安全红线」是它的压缩版，两者冲突时以 `security.md` 为准。

---

## 11. 部署

单次部署同时产出静态资源与 API：

```
wrangler deploy
```

产物：
- Worker：`/api/*` + 静态资源
- Durable Object 命名空间（每个房间一个实例）
- R2 桶：`musictogether-tracks`

环境变量：`SESSION_SECRET`（HMAC 密钥，用 `wrangler secret put` 注入）

---

## 12. 免费额度与成本（2026-10-18 核实）

> 本节记录这套栈在 Cloudflare 免费额度下的真实边界，供部署与容量评估参考。
> 下面每一条都来自 Cloudflare 官方文档，非记忆。

### 12.1 够不够用

| 资源 | 免费额度 | 本项目的用量 | 结论 |
|------|----------|--------------|------|
| DO 请求（含 WebSocket 消息） | 100,000/日 | 两人听 4 小时约数千条 | ✅ 充裕，但必须守 §6.3 的协议纪律 |
| DO 时长 | 13,000 GB-s/日 | 有 Hibernation，空闲不计费 | ✅ |
| DO SQL 存储 | 5 GB（账号级） | 只存元数据，KB 级 | ✅ |
| Worker 请求 | 100,000/日 | 每次 Range 请求算 1 次 | ✅ |
| Worker CPU | 10 ms/请求 | 纯流式转发，I/O 不计 CPU | ✅ |
| Worker 请求体 | **100 MB** | 单首歌 3–15 MB | ✅ |
| R2 存储 | 10 GB-月 | 约 1,250 首歌 | ✅ |
| R2 Class B（读） | 10,000,000/月 | 每首约数十次 Range | ✅ |
| R2 出口流量 | **免费** | B 下载不花钱 | ✅ |

**唯一需要花钱的场景**：DO 的免费额度是**按日硬上限**，超了当天就报错（次日 UTC 零点重置）。小规模使用撞不到。若日后想加缓冲，Workers Paid 是 **$5/月**。

### 12.2 核实中发现的坑（已并入设计）

1. **WebSocket 消息算 DO 请求** —— 协议必须"只在状态变化时说话"
2. **WebSocket 空闲超时存在，时长未公开** —— 必须客户端心跳
3. **Worker 内存 128 MB** —— R2 响应必须流式，不能缓冲
4. **R2 的 Worker API 不自动产出 `206`** —— `Content-Range` 要自己拼
5. **网络更新会掐断 WebSocket** —— 重连是必需项，不是优化项
6. **请求体 100 MB 上限挂在"Zone 计划"上**，升级 Workers Paid 不一定能提高

### 12.3 官方文档自相矛盾、无法定论之处

- **SQLite DO 的单对象存储上限**：FAQ 说免费计划 1 GB，同一页的表格暗示每对象 10 GB + 每账号 5 GB。**无解**。本项目不受影响（只存元数据）。
- **免费计划是否对 WebSocket 消息套用 20:1 折算**：折算说明里写的是"仅用于计算请求计费"。**未知**。按 1:1 保守估算。
- **免费计划的 DO 调用 CPU 预算是 10 ms 还是 30 s**：两处文档说法冲突。本项目不受影响（不做 CPU 密集操作）。

### 12.4 另一条路（记录备查）

R2 **公开桶 + 自定义域**可以直接绕过 Worker 提供 Range 服务，零 Worker 请求、零 CPU，只算 R2 Class B。代价是完全无鉴权——拿到链接的人永久可下载。**本项目不采用**（见 §10）。

（`r2.dev` 子域官方明说不适合生产，且有可变速率限制，就更不考虑了。）
