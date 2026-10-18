# MusicTogether 3D 舞台 设计规格

> 一句话：房间中间有一台黑胶唱片机，音乐的低音与高音驱动周围的粒子与灯光；
> 主题是房间级的状态，谁都能换，两边一起过渡。

状态：**设计已定，尚未实现**（2026-10-18）

---

## 0. 本次做与不做

**做**

- 全屏 3D 舞台，现有 UI 变成磨砂浮层浮在上面
- 中央一台黑胶唱片机，播放时缓缓转动
- 低音 / 高音分频驱动粒子与灯光
- 首个主题「晨光」（粉白 / 浅橙 / 淡墨绿）
- 房间级主题同步的**完整管道**：协议、白名单校验、持久化、老房间迁移、回归测试
- 切歌时整个场景的过渡动画

**不做（明确）**

- 星空 / 海边 / 赛博朋克 —— 之后再加，加的时候**只动主题数据**
- 任何 3D 模型文件（GLTF / DRACO / KTX2）。那些 loader 会创建 blob worker，
  而我们的 CSP 只回落到 `default-src 'self'`，blob 会被挡；唱片机用基础几何体拼更小更可控
- 任何后期处理（bloom 等）。它是赛博朋克的灵魂，也是手机的性能杀手，
  跟"一起听歌时手机不能烫"直接冲突。这一版**完全不做**，桌面端也不做 ——
  留到暗色主题那一步再一起考虑
- 把文件名、昵称或任何用户内容画进场景（理由见 §10）
- 场景内的交互（拖拽、点击物体）
- **每帧广播音频能量**（理由见 §4.4，这条会撞死免费额度）

---

## 1. 决策记录

以下每一条都是与用户逐条确认过的，不是推断。

| # | 决策点 | 结论 |
|---|--------|------|
| S1 | 主题归属 | **房间级，服务端权威**。跟播放/暂停一样平权：任何人切，两边一起过渡 |
| S2 | 场景占位 | **全屏舞台**，UI 是磨砂浮层 |
| S3 | 明暗基调 | 首个主题是暖色亮底；暗色主题（星空等）之后作为**可选项**，不做默认 |
| S4 | 主题系统 | **一套渲染器，主题是「数据 + 工厂」**。唱片机恒定，主题只换环境 |
| S5 | 律动数据 | **三层兜底**，且绝不反过来影响播放 |
| S6 | 首个主题配色 | 粉白 / 浅橙 / 淡墨绿（读法见 §13） |

---

## 2. 可行性已查实（2026-10-18）

三条都是实测，不是推断。

| 事实 | 结论 |
|------|------|
| `three.module.js`(662 KB) 与 `three.core.js`(1.4 MB)，r186：`eval` **0 处**、`new Function` **0 处**、动态 `Function(...)` **0 处**、blob worker **0 处** | **CSP 一行都不用改**，红线 15 守得住 |
| 现有 CSP 已有 `img-src 'self' data: blob:` 与 `media-src 'self' blob:` | 程序化贴图、本地缓存的 blob 音频都合法 |
| `three` 是 MIT、ESM（`"type": "module"`） | 可用动态 `import()` 按需加载，不拖累首屏 |

8 处 `Function(` 全是 `setConsoleFunction(` / `getConsoleFunction(` 这类内部 API；
唯一的 `URL.createObjectURL` 出现在 JSDoc 注释里。

**这一条是整个方案的生死线**：CSP 的 `script-src` 没有 `unsafe-eval`，而红线 15
禁止给它加。如果 three 的核心需要 `eval`，这条路当场作废。实测下来它不需要。

---

## 3. 架构

```
src/client/stage/
  stage.ts          拥有 canvas / renderer / 相机 / RAF 循环；订阅 store
  analyser.ts       律动数据的获取（三层兜底）
  energy.ts         纯函数：FFT 频段 → { level, bass, treble }
  quality.ts        画质档位与自适应降级
  turntable.ts      黑胶唱片机（恒定中心）
  themes/types.ts   Theme 接口
  themes/dawn.ts    「晨光」
  themes/index.ts   注册表：ThemeId → 工厂

src/shared/themes.ts   主题 id 白名单（纯数据，前后端共用）
```

### 3.1 为什么场景层不是 Preact 组件

`player.ts` 已经是「独立模块 + 自己订阅 store」的模式，场景层照做：
`stage.ts` 自己持有 canvas、renderer、相机与 RAF 循环，用 signals 的 `effect()`
订阅 `store.room`；Preact 只渲染浮层，canvas 是它从不重渲染的兄弟节点。

反过来做（把 3D 塞进 `<Stage />` 组件）的代价是实打实的：聊天每来一条消息、
队列每次变化都会触发重渲染，而那些重渲染会碰到 canvas 节点；更根本的是
**3D 是每帧渲染，Preact 是每次状态变化渲染**，两者混进同一个调度器会出难查的抖动。

### 3.2 数据流是单向的

```
store.room (signal)  ──effect()──▶  Stage  ──▶  Theme
      ▲                                            │
      └────────── store.send({type:'theme'}) ◀─────┘  仅由用户点击触发
```

Stage **绝不把任何 3D 状态写回 store**。唯一的回写是用户主动点主题切换器。

### 3.3 主题接口

```ts
export interface ThemeContext {
  scene: Scene;
  renderer: WebGLRenderer;
  quality: QualityTier;
}

export interface Theme {
  /** 建环境：背景、雾、灯光、粒子。不含唱片机 —— 那是 Stage 的 */
  build(ctx: ThemeContext): void;
  /** 每帧。energy 是本地分析出来的，不是从服务端来的 */
  update(dt: number, energy: Energy): void;
  /** 交叉淡入淡出的权重：0 = 完全退场，1 = 完全在场 */
  setWeight(weight: number): void;
  dispose(): void;
}
```

切主题时新旧两个 Theme 同时在世，靠 `setWeight` 交叉淡入淡出（默认 900 ms），
过渡结束旧的才 `dispose()`。**同一时刻最多两个 Theme 存活**，这是硬约束 ——
它同时限定了内存与每帧开销的上界。

---

## 4. 律动数据：三层兜底

这是本次改造里**唯一威胁到已验收能力**（锁屏 / 后台继续播放）的地方，
所以整条链按"绝不让可视化反过来弄坏播放"来设计。

### 4.1 三层

1. **主路 `captureStream()`**
   `audio.captureStream()` → `ctx.createMediaStreamSource(stream)` → `AnalyserNode`。
   关键在于**它不重路由 audio 元素自己的输出** —— 元素照常播放，
   我们只是从旁边接一路出来分析。

2. **备路 `createMediaElementSource()`**
   部分浏览器没有 `captureStream`。这条路把元素的输出整个搬进 Web Audio 图。
   **陷阱**：`createMediaElementSource()` 一旦调用就**不可撤销**，
   该元素的输出永久走这个图。所以"销毁分析器"绝不能 `disconnect()` 了事 ——
   必须把 `source → destination` 重新接上，否则整首歌永久静音。
   这条要写进代码注释，它是"加了可视化之后没声音"这类 bug 的标准成因。

3. **兜底：程序化呼吸**
   拿不到任何频域数据时，按播放锚点推算一条缓慢起伏的曲线。
   场景永不呆滞，节奏感弱一档，但绝不出错。

三层全挂也不影响播放：分析链上任何一步抛异常就整条摘掉，退到下一层。

### 4.2 AudioContext 必须在用户手势里创建

浏览器自动播放策略要求 `AudioContext` 由用户手势启动。但播放可能是**对方**发起的，
本地没有手势。所以：在页面第一次 `pointerdown` 时惰性创建 AudioContext
（一次性监听，用完即摘）；在那之前走兜底路线。
`ctx.state === 'suspended'` 时同样退到兜底。

### 4.3 频段映射（纯函数，跑在 node 里可测）

`energy.ts` 不碰 DOM：输入是 `Uint8Array`（`getByteFrequencyData` 的结果）与采样率，
输出 `{ level, bass, treble }`，各 0..1。

- `bass`：20–250 Hz
- `treble`：4–16 kHz
- `level`：全频段均值

平滑：对上一帧做指数平滑，**攻击快、释放慢**（约 80 ms / 400 ms）。
不做平滑的话粒子会随每一个鼓点抖成噪声。

### 4.4 绝不上行

**音频能量只在本地算，绝不通过 WebSocket 广播。**
每秒 60 帧的能量帧会立刻撞死 DO 的 100,000 次/日免费额度（`docs/spec.md` §6.3 的协议纪律）。

两个人各自分析自己那份音频即可 —— 他们的 `<audio>` 播的是同一首歌的同一位置，
本地算出来的能量天然是同步的。**同步的是时间轴，不是能量帧。**

---

## 5. 房间级主题同步

### 5.1 共享白名单 `src/shared/themes.ts`

```ts
export const THEME_IDS = ['dawn'] as const;
export type ThemeId = (typeof THEME_IDS)[number];
export const DEFAULT_THEME: ThemeId = 'dawn';

export function isThemeId(v: unknown): v is ThemeId {
  return typeof v === 'string' && (THEME_IDS as readonly string[]).includes(v);
}
```

放在 `shared/` 是因为**服务端也要校验**，两边必须认同同一份 id 表。
（`src/shared/` 只能是纯函数与类型，这里符合。）

### 5.2 协议

| 方向 | 消息 |
|------|------|
| 客户端 → 服务端 | `{ type: 'theme'; theme: ThemeId }` |
| 服务端 → 客户端 | `{ type: 'theme'; theme: ThemeId }` |

`state` 快照里的 `room.theme` 自动带上（`RoomState` 新增该字段），
所以中途进房与重连的人立刻看到正确的场景。

`src/client/store.ts` 的 `handle()` 加一条 `case 'theme'`，
把 `store.room.value` 换成带新主题的对象（与 `members` 那条同形）。

### 5.3 服务端 `src/server/room.ts`

照 `/track-ready` 的样子加一条 `/theme` 路由：

```ts
private async setTheme(request: Request): Promise<Response> {
  const body = await request.json().catch(() => null);
  const theme = (body as { theme?: unknown } | null)?.theme;
  if (!isThemeId(theme)) return fail(400, 'bad theme');

  const room = await this.load();
  if (room.theme === theme) return Response.json({ ok: true }); // 幂等，不广播

  room.theme = theme;
  await this.save();
  this.broadcast({ type: 'theme', theme });
  return Response.json({ ok: true });
}
```

### 5.4 老房间的迁移（容易漏，且本地大概率撞不到）

主题是新增字段，**已经存在的房间状态里没有它**。
`load()` 里必须兜底：

```ts
theme: isThemeId(stored.theme) ? stored.theme : DEFAULT_THEME,
```

不兜底的话老房间拿到 `undefined`，客户端查表查不到，场景直接不出来 ——
而这个 bug 只在"升级前建过房间"的设备上复现。

### 5.5 为什么 id 必须过白名单

主题 id 会**落进 DO 的持久化状态并广播给全房间**。不校验的话：

- 任意长度的字符串可以无限撑大房间状态（红线 4 的资源维度）
- 服务端不认识的字符串会流到客户端

客户端只拿它查表，所以这不是 XSS；但"边界处一律校验"是红线 4，没有例外。

---

## 6. 画质与降级

| 档位 | 像素比 | 粒子数 | 目标 |
|------|--------|--------|------|
| high | ≤2 | 1200 | 桌面 |
| medium | ≤1.5 | 500 | 中端手机 |
| low | 1 | 150 | 低端手机 / 发热降频 |

三档都不做后期处理（§0）。

- 起手按 `navigator.hardwareConcurrency` 与 `matchMedia('(pointer: coarse)')` 猜一档，
  之后**只看实测帧时间**：2 秒滚动窗口的平均帧时间 > 24 ms 就降一档。
- **只降不升。** 升档会在临界点上反复横跳，那种抖动比一直低画质更难忍。
- 档位记在 `localStorage`，**不上行、不进房间状态**。
  —— 画质是设备的事，主题才是房间的事，两者不要混。
- `document.hidden` 为真时**整个 RAF 循环停掉**。锁屏 / 切后台时不该有任何渲染开销。
- `prefers-reduced-motion: reduce` 时渲染静态场景：唱片不转、粒子不动，
  播放状态由现有 UI 表达。
- **体积**：首屏 JS（不含按需加载的 stage chunk）相对现在增长 **< 5 KB**；
  stage chunk 的实测体积记进 `memory/progress.md`。

---

## 7. 界面：全屏舞台 + 磨砂浮层

- `<canvas class="stage-canvas" aria-hidden="true">`：`position: fixed; inset: 0; z-index: 0`
- `.room` 提到 `z-index: 1`；两列布局与所有面板保持现在的位置关系不变
- 面板改成磨砂玻璃：
  `background: color-mix(in srgb, var(--surface) 78%, transparent)`
  ＋ `backdrop-filter: blur(18px) saturate(1.2)`
- **对比度由面板自己的底色保证，不指望背后的场景。**
  这一版场景是亮的，但将来会有暗主题；面板必须在两种背景下都到 WCAG AA。
  `backdrop-filter` 不被支持时用 `@supports not` 退回更高的不透明度。
- 场景纯粹是装饰：`aria-hidden`、不接收指针事件、不渲染任何用户内容
- **主题切换器**：`THEME_IDS.length > 1` 时才出现在头部。
  当前只有一个主题，所以这一版**界面上看不到切换器** ——
  但管道（协议、校验、持久化、测试）全都建好了，加第二个主题只改主题数据。

---

## 8. 「晨光」这个主题长什么样

| 色 | 值 | 用途 |
|----|-----|------|
| 粉白 | `#fdf4f0` | 背景与雾。清晨薄雾的感觉，接近现有 `--bg` 的暖纸底 |
| 浅橙 | `#f2a172` | 主光与粒子的主色，延续现有 `--ember-400` |
| 淡墨绿 | `#8fa89a` | 对比色：唱臂、转盘边缘、部分粒子。**没有它整屏只有一个色系，会糊** |

场景：

- 中央一台黑胶唱片机，用基础几何体拼（圆柱转盘 + 薄圆盘唱片 + 细长唱臂）
- 唱片播放时缓缓转动（比真实 33⅓ rpm 慢，看得出在转就行）；暂停时停住
- 粒子：大量细小的光点缓慢漂浮
- 灯光：一盏浅橙主光打亮唱片机
- **低音**把粒子向外推开、整体光晕扩张；**高音**让粒子闪烁变亮
- **切歌时**：粒子先向外炸开再重新聚拢，唱片机做一次轻微的缩放呼吸，
  颜色在 900 ms 内完成过渡

---

## 9. 错误处理：场景坏了不能影响播放

三条硬规则，每条都有对应的测试（§11）。

1. **WebGL 拿不到就整个不挂载。** `canvas.getContext('webgl2')` 返回 null
   （老设备、驱动被禁、无头浏览器）时 `stage.mount()` 直接返回，
   页面行为与现在一模一样。
2. **`import('three')` 失败也不能影响应用。** 动态 import 用 try/catch 包住；
   网络抖动导致 stage chunk 拉不下来时，应用照常用。
3. **分析链任何一步抛异常就整条摘掉**，退到下一层；再抛就退到静态场景。
   每一层都有 try/catch，且 `dispose()` 必须把 `source → destination` 接回去（§4.1）。

---

## 10. 安全

- 主题 id 过白名单（§5.5）
- **不把文件名、昵称或任何用户内容画进场景。** 往 WebGL 里渲染文本是一条全新的
  注入面（字体、纹理、以及未来可能的 HTML 叠加），而且它换不来任何体验。
  场景里只有几何体与程序化贴图。
- **没有新增 HTTP 端点、没有新增鉴权面**：主题走的是既有的、已鉴权的 WebSocket，
  所以红线 5（`session.room === 路径房间码`）已经覆盖它
- **CSP 不变**（§2）。绝不给 `script-src` 加 `unsafe-eval`
- `three` 是第三个运行时依赖，理由：用户明确要求、MIT、**已实测 0 处
  `eval`/`new Function`**、且按需加载不影响首屏（红线 13）

---

## 11. 测试

| 层 | 用例 | 防的是 |
|----|------|--------|
| 单元 | `isThemeId` 收白名单内、拒未知 / 非字符串 / 空串 | 非法 id 落库 |
| 单元 | energy 映射：静音 → 全 0；低频为主 → `bass > treble`；输出恒在 0..1 | 频段算错、粒子暴走 |
| 集成 | WS 发合法主题 → 广播 + 落库 | 同步不生效 |
| 集成 | WS 发非法主题 → 拒绝，房间状态不变 | 红线 4 |
| 集成 | 重连后的 `state` 快照带着主题 | 重连后场景回退 |
| 集成 | 老房间（状态里没有 `theme` 字段）load 出来是默认主题 | §5.4 的迁移 |
| 集成 | 重复设置同一个主题是幂等的，不广播 | 无谓的 DO 请求 |
| E2E | 房间里存在 canvas，Join 页不存在 | 场景挂错地方 |
| E2E | 强制 WebGL 不可用 → 应用照常可加入、可播放 | 老设备白屏 |
| E2E | 强制 `import('three')` 失败 → 应用照常可加入、可播放 | 按需加载失败拖垮应用 |
| E2E | 加了场景之后音频真的在走 | 可视化弄坏播放 |

---

## 12. 需要真机验收的项

- **锁屏 / 切后台后音频继续播放**必须重新验一次 —— 这是本次改造唯一可能
  回退已验收能力的地方（§4）。验的是"加场景前后行为一致"
- 手机连续播放 30 分钟：摸机身温度、看是否掉帧到卡顿
- HarmonyOS 浏览器上 WebGL 的可用性（ArkWeb 是 Chromium 内核，预期可用，
  但没验过就是没验过）

---

## 13. 一处需要你确认的读法

你说「首个 3d 主题有粉白、浅橙、淡墨绿这三个，其他暂时不做」。

**我按"一个主题、三种配色"来做**：`THEME_IDS = ['dawn']`，「晨光」这一个场景
同时使用这三个色（见 §8 的分工）。

另一种读法是"**三个主题，各用一种色**"。如果你是这个意思，那它们是同一场景的
三套配色 —— 正是做法三里"换灯不换屋"那种效果，跟 S4 选的**做法一**有点冲突。

**两种读法在实现上只差主题数据**：注册表与协议都按 N 个主题设计，
真要三个就是往 `THEME_IDS` 里再加两个 id、各写一份配色。你说一声就行。

## 14. 风险

- **锁屏播放可能回退**（§4）。缓解：三层兜底 + 真机复验。
  真出问题就砍掉主路、只留兜底 —— 场景变弱，但播放不受影响
- **手机发热与掉帧**。缓解：只降不升的自适应档位 + `document.hidden` 停渲染
- **浅色全屏场景可能显脏**。缓解：面板不透明到能自撑对比度；粒子与雾都压得很淡。
  这一条只能靠真机效果来判
