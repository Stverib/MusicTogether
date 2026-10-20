# MusicTogether 安全设计

> 本文是实现与评审的依据。`AGENTS.md` 里的「安全红线」是本文的压缩版。
> 每条对策都标注了它防的是什么、以及它不能防什么 —— 后者同样重要。

---

## 1. 资产与信任边界

### 要保护的东西

| 资产 | 泄露后果 |
|------|----------|
| 房间里的音乐文件 | 版权内容外泄，且这是用户的私人分享 |
| 房间码 | 拿到就能听、能下载、能删队列 |
| 会话令牌 | 同上，且 30 天有效 |
| `SESSION_SECRET` | 可以伪造任意房间的任意身份，等于全盘沦陷 |
| R2 / Worker 额度 | 被刷爆后服务对真实用户不可用 |

### 信任边界

```
不可信 ──────────────────────────────────────────────── 可信
浏览器输入     →  Worker 路由  →  RoomDO  →  R2
（文件名、昵称、     （唯一的校验点）   （信任 Worker
  聊天、trackId、                       已校验过的输入）
  上传字节）
```

**核心原则：Worker 是唯一的安全边界。** 浏览器送来的一切都不可信；
`RoomDO` 只能通过 Worker 的 binding 访问，**没有公网路由**，
因此它有权信任 Worker 转发过来的、已经校验过的东西。
一旦给 DO 直接挂路由，这条就断了。

### 明确不在威胁模型内的东西

- **拥有服务器的人**（就是项目所有者自己）—— 不防内部人
- **Cloudflare 本身** —— 信任平台
- **拿到房间码的合法成员** —— 成员之间是平权的，不互相防
- **物理接触设备的人** —— 不防
- **国家级对手、流量分析** —— 超出范围

---

## 2. 攻击面与对策

### 2.1 路径穿越 → 读取其他房间的文件（严重）

**攻击**：`trackId` 来自 URL，被拼进 R2 key `rooms/<code>/tracks/<trackId>`。
若不做校验，请求

    GET /api/rooms/K7M2QX/tracks/..%2F..%2FOTHER/secret/stream

就能读到别人的文件。

**对策**：Worker 在拼接**之前**校验格式。

    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    if (!UUID_RE.test(trackId)) return fail(400, 'bad track id');

房间码同理，必须过 `isValidCode()`（字母表只有 32 个字符，天然不含 `/`、`.`）。

**能防**：穿越、编码绕过（校验发生在解码之后的字符串上）。
**不能防**：拿到合法 trackId 的人（那需要房间码，另论）。

---

### 2.2 上传 HTML 后直接访问 → 存储型 XSS（严重）

**攻击**：上传时客户端声明 `mime: "text/html"`。如果流式端点把这个值原样回显成
`Content-Type`，受害者直接导航到

    https://app/api/rooms/CODE/tracks/ID/stream

浏览器就会把文件当 HTML 执行 —— 而它跑在同源下，可以读写该源的 IndexedDB
（缓存里的其他歌）、发起带 Cookie 的请求。

**对策**（三层，缺一不可）：

1. **出站 Content-Type 不由用户决定**。由扩展名映射到白名单：

       const AUDIO_MIME: Record<string, string> = {
         mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac',
         flac: 'audio/flac', ogg: 'audio/ogg', oga: 'audio/ogg',
         opus: 'audio/ogg', wav: 'audio/wav', wma: 'audio/x-ms-wma',
       };

   扩展名不认识就退回 `application/octet-stream`。

2. **`X-Content-Type-Options: nosniff`** —— 禁止浏览器自行嗅探。

3. **`Content-Disposition: inline`** 加上白名单类型，浏览器会当媒体处理而非文档。

**能防**：HTML/JS/SVG 被当作文档执行。
**不能防**：用户上传的音频本身有恶意（音频解码器漏洞）—— 这属于浏览器沙箱的责任。

---

### 2.3 跨站 WebSocket 劫持（CSRF，高危且易被忘）

**攻击**：WebSocket 握手**不受同源策略约束**，也不受 `SameSite` 保护。
攻击者在 `evil.com` 上放一段脚本：

    new WebSocket('wss://app/api/rooms/CODE/ws')

浏览器会**自动带上**该域的所有 Cookie。攻击者于是拿到了一个已鉴权的房间连接，
可以监听播放状态、读取队列、发聊天消息。

**对策**：Worker 在升级前校验 `Origin`：

    const origin = request.headers.get('Origin');
    if (!origin || new URL(origin).host !== new URL(request.url).host) {
      return fail(403, 'bad origin');
    }

注意：`Origin` 头在非浏览器客户端里可以伪造 —— 但那种情况下攻击者本来就能直接
调 API，`Origin` 校验防的正是"借用户浏览器的手"这一类。

**能防**：浏览器发起的跨站 WebSocket。
**不能防**：非浏览器客户端伪造 Origin（但它们需要先拿到 Cookie，等于已经赢了）。

---

### 2.4 房间码枚举

**攻击**：房间码 32⁶ ≈ 10.7 亿种。`/join` 对存在的房间返回 200、不存在返回 404 ——
这是个完美的探针。不设防的话，高并发下几天能扫完，且一旦命中就能听、能下、能删。

**对策**：

1. **限速**用一个全局 `GuardDO`，按 IP 做滑动窗口：
   - `/api/rooms`（建房）：10 次 / 分钟 / IP
   - `/api/rooms/:code/join`：20 次 / 分钟 / IP
   - 上传：60 次 / 分钟 / IP
   超限返回 `429` + `Retry-After`。

2. 房间码用 **Crockford Base32** 而不是纯数字 —— 纯数字 6 位只有 100 万种，
   限速也救不了。

**诚实说明这条防线的强度**：按 IP 限速可以被代理池绕过；
`GuardDO` 本身是单点，也会成为吞吐瓶颈。对一个小规模自用项目，这足够了；
如果这个项目要对外开放，需要换成 Cloudflare 的 Rate Limiting 产品 + WAF。
**这一条是纵深防御，不是保证。**

---

### 2.5 越权访问其他房间（横向）

**攻击**：会话令牌里的 `room` 是 `K7M2QX`，攻击者拿它去请求 `ZZZZZZ` 房间的资源。
令牌签名是合法的。

**对策**：**每个房间路由都必须校验 `session.room === 路径里的房间码`**，
然后再把请求转给 DO。签名只证明"你是谁"，不证明"你能进哪个房间"。

**回归测试**：`test/integration/media.test.ts` 里有「跨房间的 trackId 不能写入」，
`test/integration/stream.test.ts` 里有「别的房间的令牌读不到这个房间的歌」。
这两条必须一直绿。

---

### 2.6 聊天与文件名的 XSS（中危）

**攻击**：昵称可以是 `<img src=x onerror=fetch('/api/me')>`，文件名同理。

**对策**：
- Preact 的 `{value}` 默认转义 —— **保持默认，永远不用 `dangerouslySetInnerHTML`**
- 服务端把聊天文本**原样存原样发**（不做 HTML 转义）—— 转义是**输出端**的责任，
  在输入端转义会导致双重转义，且骗不过其他输出渠道
- 加 CSP 作为纵深防御：

      default-src 'self';
      script-src 'self';
      style-src 'self' 'unsafe-inline';
      img-src 'self' data: blob:;
      media-src 'self' blob:;
      connect-src 'self' ws: wss:;
      object-src 'none';
      base-uri 'none';
      frame-ancestors 'none';

**回归测试**：`test/integration/chat.test.ts` 有「消息里的 HTML 原样传回」——
这条测的正是"服务端不做转义"，配合前端的默认转义才完整。

---

### 2.7 资源耗尽

**攻击**：拿到一个房间码后无限上传，把 R2 免费额度（10 GB）填满，
或者用超大文件打满 Worker 请求数。

**对策**：
1. **单文件上限 100 MB**（Workers 请求体硬上限就是这个数）
2. **每房间配额**：最多 200 首、总计 2 GB。上传前在 DO 里查，超了返回 `413`
3. **不信任 `Content-Length`** —— 流式读取时累计计数，超了立刻中断并删除半截对象
4. DO 的 WebSocket 消息数计入 100k/日额度 → 协议纪律（只在状态变化时说话）
   本身就是一条 DoS 对策

---

### 2.8 令牌不可吊销（已知取舍）

HMAC 会话是无状态的，因此**无法吊销**，只能等 30 天过期。
被移出房间的人在令牌过期前仍能用 `/stream` 读到他已知 trackId 的文件。

**为什么接受**：改成可吊销就要每次流式请求都查 DO —— 而浏览器为一首歌会发几十个
Range 请求，成本放大几十倍。对小规模自用场景不划算。

**缓解**：删除房间时一并删除 R2 对象，让存量的 trackId 全部失效。

---

### 2.9 依赖与供应链

当前运行时依赖只有 `preact` 和 `@preact/signals`，都是 Preact 团队维护的成熟库。
**新增运行时依赖需要有理由** —— 每多一个依赖就多一份供应链风险，
而这个项目绝大多数需求用标准 Web API 就能满足。

CI 里跑 `npm audit`，但**不要盲目 `npm audit fix`**（可能引入破坏性变更）。

---

### 2.10 分享链接把房间码放进了 URL（已知取舍）

「分享房间」生成的链接是 `/r/<房间码>`，房间码因此会出现在：

- 浏览器历史与地址栏
- 截图、录屏
- 聊天软件的**链接预览**（对方客户端与微信/QQ 的爬虫都会去取一次这个 URL）
- Cloudflare 的边缘访问日志

**为什么还是这么做**：房间码本来就是唯一的秘密，"把链接给对方"就是
"把秘密给对方" —— 这本来就是邀请的语义。没有它，邀请就得靠人肉念一串
六位码，体验差很多。

**已经做的缓解**：

- `Referrer-Policy: no-referrer` —— 从房间页跳去任何外链都带不走它
- CSP `default-src 'self'` —— 页面里没有任何第三方脚本能读到 `location`
- 加入成功后立刻 `history.replaceState('/', ...)`，地址栏与后续历史里不再挂着它
  （房间记在 localStorage，刷新照样回得来）
- 不提供任何"公开房间广场"或"可发现"能力 —— 链接没被发出去，房间就没人知道

**没有做的、要清楚的**：任何拿到链接的人都能进房间，这是设计如此，不是漏洞。
所以房间码**不要**发在公开场合。真要被滥用了，唯一的手段是「离开房间」后
另开一个新房间 —— 令牌不可吊销（见 §2.8）。

---

### 2.11 成员列表会保留已离开的人（D11 带来的新暴露）

**背景**：决策 D11 把"断线即从成员列表移除"改成了"保留并标 `online: false`"。
副作用是**房间码能揭示的东西变多了**：拿到房间码的人在成员列表里看到的
不再只是"现在有谁"，还包括"之前来过谁"（最多 20 个昵称）。

**为什么接受**：房间码本来就是唯一的秘密，拿到它的人本来就能读队列、听歌、
看聊天记录（D12 之后聊天也落库了）。多几个历史昵称不改变这条边界。
昵称还是用户自己填的、可以随时改的东西。

**缓解**：列表上限 20 人，且**只淘汰离线的最老的** —— 在线的人一个都不动，
所以这个列表不会无限增长，也不会把正在听歌的人挤掉。

**能防**：列表无限增长。**不能防**：拿到房间码的人看到历史昵称（设计如此）。

---

### 2.12 `away` 是客户端上报的（低危，但边界要说清）

**背景**：决策 D13 加了 `Member.away`，由客户端在 `visibilitychange` 时
经 `{ type: 'presence', away }` 上报 —— 服务端**无法自己判断**一个还连着的
浏览器是不是还在前台。

**这为什么不是漏洞**：这个字段的唯一用途是给房间里其他人看的展示状态。
伪造它最多是"假装自己在看"或"假装自己不在"，没有越权、没有数据泄漏、
没有资源消耗。同房间的人本来就是平权的（§1 的威胁模型里写明成员之间不互相防）。

**已经做的边界校验**：服务端**只收布尔值** —— `away: "yes"` 这种隐式真值一律
拒掉。不校验的话，一个畸形载荷会落进持久化状态并广播给全房间。

**能防**：畸形载荷写进房间状态、可见性事件成串到来时变成广播风暴（上报是幂等的）。
**不能防**：成员谎报自己的在线状态（设计如此）。

---

## 3. 必须有的安全响应头

API 响应统一在 Worker 最外层加（`withSecurity()`，一处生效）。
**静态外壳不走 Worker**（`run_worker_first: ["/api/*"]`，为了不把静态资源
也算进 Worker 请求额度），它的同一组头写在 `src/client/public/_headers` 里。

    Content-Security-Policy: <见 2.6>
    X-Content-Type-Options: nosniff
    Referrer-Policy: no-referrer
    X-Frame-Options: DENY
    Permissions-Policy: geolocation=(), camera=(), microphone=()

`Referrer-Policy: no-referrer` 很重要且容易被忽略：**房间码在 URL 路径里**，
任何外链跳转都会把它放进 `Referer` 泄漏出去。

两份 CSP 是手写的，`test/e2e/security.spec.ts` 里有一条用例直接比对
「静态外壳的 CSP」与「API 的 CSP」是否逐字符相同 —— 改一处漏另一处会红。

`script-src` 里**没有** `unsafe-inline`，所以 `index.html` 里不能有任何内联
`<script>`（Service Worker 的注册因此挪进了 `main.tsx`）。给 CSP 开
`unsafe-inline` 等于把 XSS 防线拆掉，这条没有商量余地。

---

## 4. 安全相关的回归测试清单

这些用例必须一直存在且是绿的。破坏其中任何一条都视为回归。

| 用例 | 文件 | 防的是 |
|------|------|--------|
| 跨房间的 trackId 不能写入 | `test/integration/media.test.ts` | 越权写入 |
| 别的房间的令牌读不到这个房间的歌 | `test/integration/stream.test.ts` | 横向越权 |
| 非成员无法连接 WebSocket | `test/integration/room.test.ts` | 未授权连接 |
| 跨站 Origin 的 WebSocket 被拒 | `test/integration/room.test.ts` | CSRF |
| 非法 trackId 格式返回 400 | `test/integration/stream.test.ts` | 路径穿越 |
| 上传的 Content-Type 被强制为白名单值 | `test/integration/stream.test.ts` | 存储型 XSS |
| 超过体积上限的上传被拒 | `test/integration/media.test.ts` | 资源耗尽 |
| 超过房间配额的上传被拒 | `test/integration/media.test.ts` | 资源耗尽 |
| 只有上传者能删云端文件 | `test/integration/media.test.ts` | 越权删除 |
| 聊天 HTML 原样传回（前端负责转义） | `test/integration/chat.test.ts` | XSS |
| 超长聊天被丢弃 | `test/integration/chat.test.ts` | 资源耗尽 |
| 没有会话读不到聊天历史 | `test/integration/chat.test.ts` | 未授权读历史 |
| 建房与加入的限速生效 | `test/integration/ratelimit.test.ts` | 枚举 |

端到端那一层（`test/e2e/security.spec.ts`，12 条）补的是集成测试看不到的部分：

| 用例 | 防的是 |
|------|--------|
| 静态外壳带安全头，且 CSP 与 API 逐字符一致 | 头漂移、点开页面就没有防护 |
| 页面里没有内联脚本 | 与 `script-src 'self'` 冲突（PWA 会静默失效） |
| Service Worker 能注册成功 | CSP 把 SW 挡掉导致离线/安装失效 |
| 聊天里的 `<img onerror>` 原样显示为文本，不弹窗 | 存储型 XSS |
| 恶意文件名在队列里也是纯文本 | 存储型 XSS |
| 上传 `.html` 后访问流地址，Content-Type 不是 `text/html` | 存储型 XSS |
| 路径穿越与非法 trackId 被挡（带会话） | 路径穿越 |
| 无 Cookie / 伪造令牌 → 401 | 未授权访问 |
| 拿着 A 房间的会话访问 B 房间 → 401 | 横向越权 |
| 跨站 Origin 的 WS 升级 → 403，同源的能连上 | CSRF |
| 不存在的房间 → 404，响应里没有任何 CORS 头 | 枚举、信息泄漏 |
| 非上传者删云端文件 → 403，上传者 → 200 | 越权删除 |
| 分享链接加入后地址栏不再挂着房间码 | 房间码留在历史与截图里 |
| 链接里的房间码格式不合法时安静退回普通加入页 | 畸形输入被当成房间码往下传 |

---

## 5. 上线前检查清单

已完成的（2026-10-18 本地验证）：

- [x] 仓库里 grep 不到任何密钥（`git log -p --all | grep -i secret` 只剩变量名与测试夹具）
- [x] 上述所有回归用例是绿的（集成 171 条 + 端到端 45 条）
- [x] 手工渗透验证（curl，见下方记录）
- [x] 静态外壳与 API 都带上了全部安全响应头
- [x] 生产环境 Cookie 带 `Secure`（`sessionCookie(..., secure)`，按 `url.protocol === 'https:'` 判定）

部署时才能做、**必须在上线前补上**的：

- [ ] `wrangler secret put SESSION_SECRET` 用的是 32 字节以上随机值
      （本地 `.dev.vars` 里那个只用于开发，绝不能带到生产）
- [ ] R2 桶**没有**开公开访问（没有自定义域、没有 `r2.dev`）——
      需要 Cloudflare 账号，本地无法验证
- [ ] Cloudflare 后台开了 HSTS

### 手工渗透验证记录（2026-10-18，wrangler dev）

未带会话时一律先撞上会话检查（这是对的：不向未认证者透露任何东西）：

| 请求 | 结果 |
|------|------|
| `GET /api/rooms/AAAAAA/tracks/..%2F..%2Fsecret/stream` | 401 |
| `POST /api/rooms/abc/join`（房间码长度不对） | 400 |
| `GET /api/rooms/AAAAAA/state`（无 Cookie） | 401 |
| `GET /api/me` + `Cookie: mt_sess=forged.signature` | 401 |
| `GET /api/rooms/AAAAAA/ws` + `Origin: https://evil.com` | 401 |
| `GET /api/health` + `Origin: https://evil.com` | 无任何 `access-control-*` 头 |

带上真实会话后再打一遍，才验到真正的校验点：

| 请求 | 结果 |
|------|------|
| `GET .../tracks/..%2F..%2Fsecret/stream`（带会话） | 400 |
| `GET .../tracks/not-a-uuid/stream`（带会话） | 400 |
| `GET .../ws` + `Origin: https://evil.com`（带会话） | 403 |
| `GET .../ws` 不带 `Origin`（带会话） | 403 |
| `GET /api/rooms/<自己的房间>/state` | 200 |
| `GET /api/rooms/AAAAAA/state`（别人的房间） | 401 |

限速没有在这张表里手工验：`.dev.vars` 为了跑 E2E 把 `RATE_LIMIT_SCALE`
放宽了 50 倍，手工 curl 打不出 429。真正的限额由
`test/integration/ratelimit.test.ts` 覆盖 —— 那一层显式把 scale 锁回 1。
