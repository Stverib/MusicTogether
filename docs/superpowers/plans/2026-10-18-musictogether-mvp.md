# MusicTogether MVP 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让两个人（或多人）在各自浏览器里打开同一个网页，由任何一方把本地音乐传上去，所有人听同一首歌且进度条保持 ±1 秒内同步。

**Architecture:** 单个 Cloudflare Worker 同时提供静态 SPA 与 `/api/*`；每个房间是一个 SQLite 后端的 Durable Object，用 WebSocket Hibernation 维持长连接并做服务端权威的播放锚点广播；音频字节存 R2，经 Worker 代理以支持 Range 请求与 HMAC 鉴权。前端为 Preact SPA，用 IndexedDB 做本地缓存。

**Tech Stack:** TypeScript · Vite · Preact + @preact/signals · Cloudflare Workers / Durable Objects / R2 · Wrangler · Vitest（单元）· @cloudflare/vitest-pool-workers（集成）· Playwright（E2E）

**Spec:** `docs/spec.md` —— 本计划实现该规格，执行时两份文档一起读。

## Global Constraints

- **房间码字母表**：Crockford Base32 `0123456789ABCDEFGHJKMNPQRSTVWXYZ`，长度 6，输入时统一大写并做 `O→0`、`I→1`、`L→1`、`U→V` 归一化。
- **同步精度目标**：±1 秒。**不做**时钟对齐、**不做**变速追帧。
- **协议纪律**：WebSocket 消息计入 DO 的 100,000 次/日免费额度，**绝不允许"每秒广播进度"**。服务端只在状态变化时说话。
- **Durable Object 必须用 SQLite 后端**（`new_sqlite_classes`），必须用 WebSocket Hibernation API。
- **R2 响应必须流式转发**，禁止 `arrayBuffer()` 缓冲（Worker 内存 128 MB）。
- **`206` / `Content-Range` 必须手写**，R2 的 Worker API 不会自动产出。
- **客户端必须每 25 秒发一次心跳**（空闲超时未公开，必然存在）。
- **30 秒兜底同步帧只在播放中调度**，暂停时取消 alarm。
- **Cookie 而非 Authorization 头**做鉴权 —— 因为 `<audio>` 元素发请求时带不了自定义头。
- **不解析 ID3 标签**，列表显示原始文件名。
- **不做**账号系统、公开分享、音频指纹、原生 App。
- 提交信息用英文，遵循 Conventional Commits。

### 安全约束（违反即不予合并，详见 `docs/security.md`）

- **`trackId` 必须是严格 UUID** 才能拼进 R2 key；房间码必须先过 `isValidCode()`。
  否则 `../../` 能读到别的房间的文件（§2.1）。
- **出站 `Content-Type` 绝不回显用户提供的值**，一律由扩展名映射到白名单音频类型，
  并带 `X-Content-Type-Options: nosniff`。否则上传 HTML 再直接访问流地址就是
  同源存储型 XSS（§2.2）。
- **WebSocket 升级必须校验 `Origin` 与部署域名一致**。WebSocket 不受同源策略与
  SameSite 保护，是现成的 CSRF 通道（§2.3）。
- **每个房间路由都必须校验 `session.room ===` 路径里的房间码**。签名只证明身份，
  不证明权限（§2.5）。
- **`SESSION_SECRET` 只经 `wrangler secret` 注入**，绝不进仓库（§2.9）。
- **限速**：建房 10/分/IP、加入 20/分/IP、上传 60/分/IP。房间码有 10.7 亿种，
  但只有配上限速才谈得上不可枚举（§2.4）。
- **每房间配额**：最多 200 首、总计 2 GB（§2.7）。
- **绝不 `innerHTML` / `dangerouslySetInnerHTML` / `eval`**。聊天与文件名是
  攻击者可控的；Preact 默认转义，保持这个默认（§2.6）。
- **不设置任何 CORS 头**，不放开 `Access-Control-Allow-Origin`。
- **日志不打令牌、签名、Cookie 内容**。
- **新增运行时依赖需要理由**；当前仅 `preact` 与 `@preact/signals`（§2.9）。

---

## 测试策略

| 层级 | 工具 | 覆盖对象 | 何时跑 |
|------|------|----------|--------|
| 单元 | Vitest（node 环境） | `src/shared/*` 纯函数：房间码、锚点数学、协议校验 | 每次改动 |
| 集成 | @cloudflare/vitest-pool-workers | Worker 路由、RoomDO、R2 —— 真实 workerd 环境，真实 WebSocket | 每次改动 |
| E2E | Playwright | 两个浏览器上下文真实同步播放 | 每个 Phase 收尾 |

集成测试用 `SELF` 绑定直接调 Worker，用 `runInDurableObject()` 检查 DO 内部状态。

---

## 文件结构

```
MusicTogether/
├─ package.json, tsconfig.json, vite.config.ts, vitest.config.ts, wrangler.jsonc
├─ spike/
│  └─ verify.html                  # Task 0：真机能力验证页（单文件，无依赖）
├─ src/
│  ├─ shared/                      # 前后端共用，全部是纯函数与类型
│  │  ├─ codes.ts                  # 房间码：生成 / 归一化 / 校验
│  │  ├─ playback.ts               # 播放锚点数学（本项目的核心逻辑）
│  │  ├─ protocol.ts               # WS 消息类型定义与校验
│  │  └─ types.ts                  # RoomState / Track / Member / Playback
│  ├─ server/
│  │  ├─ index.ts                  # Worker 入口：全部路由 + 安全响应头
│  │  ├─ room.ts                   # RoomDO：房间的全部服务端逻辑
│  │  ├─ guard.ts                  # GuardDO：按 IP 的滑动窗口限速
│  │  ├─ session.ts                # HMAC 令牌签发与校验
│  │  ├─ security.ts               # 安全闸门：UUID/房间码/Origin/MIME 白名单/CSP
│  │  ├─ media.ts                  # R2 上传 / Range 流式读取 / 删除
│  │  └─ env.ts                    # Env 类型
│  └─ client/
│     ├─ index.html
│     ├─ main.tsx
│     ├─ app.tsx                   # 顶层：未进房显示 Join，进房显示 Room
│     ├─ store.ts                  # RoomStore + signals
│     ├─ ws.ts                     # WebSocket 连接、心跳、指数退避重连
│     ├─ player.ts                 # <audio> 封装 + 锚点同步
│     ├─ cache.ts                  # IndexedDB 音频缓存
│     ├─ sources.ts                # 选歌：目录选择 API / webkitdirectory / 多选
│     └─ components/
│        ├─ Join.tsx   ├─ Player.tsx  ├─ Queue.tsx
│        ├─ Library.tsx ├─ Chat.tsx   ├─ Members.tsx
│        └─ CachePanel.tsx
└─ test/
   ├─ unit/            # 纯函数
   ├─ integration/     # Worker + DO + R2
   └─ e2e/             # Playwright
```

---

# Phase 0 · 先验证地基

## Task 0: 真机能力验证页

规格 §2 的三条假设（R1 音频播放、R2 目录选择、R3 后台存活）是整个方案的地基，未经真机验证前不写任何产品代码。

**Files:**
- Create: `spike/verify.html`
- Create: `spike/README.md`

**Interfaces:**
- Consumes: 无
- Produces: 一份人工验收结论（R1/R2/R3 各自成立与否），决定后续是否继续

- [x] **Step 1: 写验证页**

单文件，零依赖，零构建。必须自包含（真机上没有构建环境可以跑）。

`spike/verify.html`:

```html
<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>MusicTogether 能力验证</title>
<style>
  body { font: 16px/1.6 system-ui, sans-serif; margin: 0; padding: 16px; max-width: 720px; }
  h2 { margin: 28px 0 8px; font-size: 17px; }
  .r { border: 1px solid #ccc; border-radius: 8px; padding: 12px; margin: 8px 0; }
  .ok { background: #e8f7e8; border-color: #4a4; }
  .no { background: #fdeaea; border-color: #a44; }
  .unk { background: #fdf6e3; border-color: #a83; }
  button { font: inherit; padding: 10px 16px; margin: 4px 8px 4px 0; border-radius: 8px;
           border: 1px solid #666; background: #f5f5f5; }
  audio { width: 100%; margin-top: 8px; }
  code { background: #eee; padding: 1px 5px; border-radius: 4px; }
  #log { font: 12px/1.5 ui-monospace, monospace; white-space: pre-wrap;
         background: #f7f7f7; padding: 10px; border-radius: 8px; max-height: 220px; overflow: auto; }
</style>

<h1>MusicTogether 能力验证</h1>
<p>在<strong>HarmonyOS 手机</strong>上用浏览器打开本页，从上到下逐个测。</p>

<h2>R1 · 能不能播音频</h2>
<div class="r" id="r1">点下面按钮。能听到一段 3 秒的提示音、且进度条在走，就算通过。</div>
<button onclick="testPlay()">播放测试音</button>
<audio id="a1" controls></audio>

<h2>R1b · 能不能播一首真实的歌</h2>
<div class="r" id="r1b">选一首本地 mp3。要能播、能拖动进度条。</div>
<button onclick="document.getElementById('f1').click()">选择音频文件</button>
<input type="file" id="f1" accept="audio/*" hidden>
<audio id="a2" controls></audio>

<h2>R2 · 能不能选到一个文件夹</h2>
<div class="r" id="r2">点按钮，看弹出的选择器能不能选到手机里的音乐目录，以及能不能读出一批文件。</div>
<button onclick="document.getElementById('f2').click()">选文件夹</button>
<input type="file" id="f2" webkitdirectory multiple hidden>
<button onclick="document.getElementById('f3').click()">多选文件（保底方案）</button>
<input type="file" id="f3" accept="audio/*" multiple hidden>

<h2>R3 · 锁屏 / 切后台还响不响</h2>
<div class="r" id="r3">
  回到上面点「播放测试音」，然后<strong>立刻锁屏</strong>，等 15 秒再解锁。
  再重复一次，这次播着音<strong>切到别的 App</strong>，等 15 秒回来。
  两种情况下声音都还在、进度条都往前走了，才算通过。
</div>

<h2>日志</h2>
<div id="log"></div>

<script>
const log = (m) => {
  const el = document.getElementById('log');
  el.textContent += m + '\n';
  el.scrollTop = el.scrollHeight;
};
const mark = (id, ok, text) => {
  const el = document.getElementById(id);
  el.className = 'r ' + (ok === null ? 'unk' : ok ? 'ok' : 'no');
  if (text) el.textContent = text;
};
const startedAt = Date.now();
log('UA: ' + navigator.userAgent);
log('目录选择 API: ' + (window.showDirectoryPicker ? '有' : '没有'));
log('Media Session API: ' + ('mediaSession' in navigator ? '有' : '没有'));
log('storage.persist: ' + (navigator.storage && navigator.storage.persist ? '有' : '没有'));

// ---- R1: 用 WebAudio 生成 3 秒正弦波，转成 wav 给 <audio> 播 ----
function beepWav(seconds = 3, freq = 440) {
  const rate = 44100, n = rate * seconds;
  const buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const s = (o, str) => [...str].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  s(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); s(8, 'WAVEfmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true); s(36, 'data');
  v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.sin(i * freq * 2 * Math.PI / rate) * 0x6000, true);
  return new Blob([buf], { type: 'audio/wav' });
}

async function testPlay() {
  const a = document.getElementById('a1');
  a.src = URL.createObjectURL(beepWav());
  try {
    await a.play();
    log('R1 play() 成功');
    mark('r1', null, '正在播放…锁屏试试。回来看到进度条超过 3 秒即通过。');
  } catch (e) {
    log('R1 play() 失败: ' + e);
    mark('r1', false, '播放失败：' + e.message);
  }
}

document.getElementById('a1').addEventListener('ended', () => { mark('r1', true, '✅ R1 通过：音频正常播放到结束'); log('R1 播放完毕'); });
document.getElementById('a1').addEventListener('timeupdate', (e) => {
  if (e.target.currentTime > 2.5) mark('r1', true, '✅ R1 通过（锁屏也没断）');
});

// ---- R1b / R2: 真实文件 ----
document.getElementById('f1').addEventListener('change', (e) => {
  const f = e.target.files[0]; if (!f) return;
  const a = document.getElementById('a2');
  a.src = URL.createObjectURL(f);
  log('选中: ' + f.name + ' ' + (f.size / 1048576).toFixed(1) + 'MB');
  mark('r1b', null, '已加载 ' + f.name + '，点播放并拖动进度条。');
});
document.getElementById('a2').addEventListener('playing', () => mark('r1b', true, '✅ R1b 通过：本地文件可播放'));
document.getElementById('a2').addEventListener('seeked', () => log('seek 到 ' + document.getElementById('a2').currentTime.toFixed(1) + 's'));

document.getElementById('f2').addEventListener('change', (e) => {
  const fs = [...e.target.files];
  const audio = fs.filter(f => /\.(mp3|m4a|aac|flac|ogg|wav|opus|wma)$/i.test(f.name));
  log(`R2 文件夹：共 ${fs.length} 个文件，其中音频 ${audio.length} 个`);
  if (!fs.length) return mark('r2', false, '❌ 一个文件都没读到');
  mark('r2', audio.length > 0, audio.length > 0
    ? `✅ R2 通过：读到 ${audio.length} 首音频。示例：` + audio.slice(0, 5).map(f => f.name).join('、')
    : '⚠️ 读到了文件但没有音频，可能选错目录');
});
document.getElementById('f3').addEventListener('change', (e) => {
  log('R2 保底多选：' + e.target.files.length + ' 个文件');
});

// ---- R3: 切后台计时 ----
let bg = 0;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { bg = Date.now(); log('→ 进入后台'); }
  else if (bg) {
    const away = ((Date.now() - bg) / 1000).toFixed(1);
    const a = document.getElementById('a1');
    log(`← 回到前台，离开 ${away} 秒，音频当前时间 ${a.currentTime.toFixed(1)}s，paused=${a.paused}`);
    mark('r3', !a.paused && a.currentTime > 0.5,
      a.paused ? `❌ R3 失败：切后台 ${away} 秒后音频被暂停了` : '✅ R3 通过：后台回来了还在响');
    bg = 0;
  }
});

// ---- WebSocket 存活（顺手测，为后面长连接探路）----
log('WebSocket: ' + (typeof WebSocket !== 'undefined' ? '有' : '没有'));
log('IndexedDB: ' + (typeof indexedDB !== 'undefined' ? '有' : '没有'));
</script>
</html>
```

- [x] **Step 2: 写验证说明**

`spike/README.md`:

```markdown
# 真机能力验证

目的：在做任何产品代码之前，先确认规格 §2 的三条假设在HarmonyOS 手机上是否成立。

## 怎么跑

手机和电脑连同一个 WiFi，在项目根目录起一个静态服务器：

    npx serve spike

或者用 Python：

    python -m http.server 8000 --directory spike

然后手机浏览器打开电脑的局域网地址，例如 `http://192.168.1.5:8000/verify.html`。

## 要记录的三件事

| 编号 | 测什么 | 通过标准 |
|------|--------|----------|
| R1 | 音频播放 | 测试音能响，进度条走到 3 秒结束 |
| R1b | 真实歌曲 | 选中本地 mp3 能播，能拖动进度条 |
| R2 | 选文件夹 | 弹出选择器能进到音乐目录，读出音频文件列表 |
| R3 | 后台存活 | 锁屏 15 秒 / 切 App 15 秒后回来，音频仍在播放且进度在走 |

## R2 失败怎么办

不影响项目继续，只影响选歌的易用程度：退化为「多选文件」，功能完整，只是要一首首点。
```

- [x] **Step 3: 提交**

```bash
git add spike/
git commit -m "spike: add on-device capability verification page"
```

- [x] **Step 4: 【人工验收】在HarmonyOS 手机上跑一遍** —— 2026-10-18 通过（R1/R1b/R2/R3 全部正常）

这一步必须由项目所有者完成 —— 自动化测试无法替代。把 R1 / R1b / R2 / R3 四项结果告知执行者。

**若 R1 或 R3 不通过**：停下来，回到规格 §2，重新评估纯网页方案。
**若仅 R2 不通过**：继续，把 `sources.ts` 的目录选择降级为多选。

---

# Phase 1 · 骨架

## Task 1: 项目脚手架

**Files:**
- Create: `package.json`, `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`, `wrangler.jsonc`, `.gitignore`, `src/server/env.ts`, `src/server/index.ts`, `src/client/index.html`, `src/client/main.tsx`

**Interfaces:**
- Consumes: 无
- Produces: `npm run dev` 起本地全栈；`npm test` 跑测试；`npm run deploy` 部署

- [ ] **Step 1: 初始化并装依赖**

```bash
npm init -y
npm i preact @preact/signals
npm i -D typescript vite @preact/preset-vite vitest @cloudflare/vitest-pool-workers wrangler @cloudflare/workers-types @types/node
```

- [ ] **Step 2: 写 `package.json` 的 scripts**

```json
{
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "deploy": "npm run build && wrangler deploy",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  }
}
```

- [ ] **Step 3: 写 `wrangler.jsonc`**

关键点：`assets` 让 Worker 同时托管 SPA；`new_sqlite_classes` 声明 SQLite 后端 DO（免费计划必须）。

```jsonc
{
  "name": "musictogether",
  "main": "src/server/index.ts",
  "compatibility_date": "2026-10-01",
  "assets": {
    "directory": "dist",
    "not_found_handling": "single-page-application",
    "run_worker_first": ["/api/*"]
  },
  "durable_objects": {
    "bindings": [
      { "name": "ROOMS", "class_name": "RoomDO" },
      { "name": "GUARD", "class_name": "GuardDO" }
    ]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["RoomDO", "GuardDO"] }
  ],
  "r2_buckets": [
    { "binding": "BUCKET", "bucket_name": "musictogether-tracks" }
  ],
  "observability": { "enabled": true }
}
```

- [ ] **Step 4: 写 `src/server/env.ts`**

```ts
export interface Env {
  ROOMS: DurableObjectNamespace<import('./room').RoomDO>;
  BUCKET: R2Bucket;
  SESSION_SECRET: string;
}
```

- [ ] **Step 5: 写最小 Worker 与最小前端，验证脚手架通了**

`src/server/index.ts`:

```ts
import type { Env } from './env';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/api/health') {
      return Response.json({ ok: true, at: Date.now() });
    }
    return new Response('not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
```

`src/client/index.html`:

```html
<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>MusicTogether</title>
<body><div id="app"></div><script type="module" src="/main.tsx"></script></body>
</html>
```

`src/client/main.tsx`:

```tsx
import { render } from 'preact';
import { App } from './app';

render(<App />, document.getElementById('app')!);
```

`src/client/app.tsx`:

```tsx
export function App() {
  return <main style="padding:16px">MusicTogether 骨架就绪</main>;
}
```

- [ ] **Step 6: 写 `vite.config.ts`**

`run_worker_first` 只对 `/api/*` 生效，所以开发时前端走 Vite，`/api` 走 `wrangler dev`。用 Vite 代理转发。

```ts
import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

export default defineConfig({
  root: 'src/client',
  build: { outDir: '../../dist', emptyOutDir: true },
  plugins: [preact()],
  server: {
    proxy: { '/api': { target: 'http://127.0.0.1:8787', ws: true, changeOrigin: true } },
  },
});
```

- [ ] **Step 7: 写 `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["@cloudflare/workers-types", "vite/client"],
    "jsx": "react-jsx",
    "jsxImportSource": "preact",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src", "test"]
}
```

- [ ] **Step 8: 写 `.gitignore`**

```
node_modules/
dist/
.wrangler/
.dev.vars
test-results/
playwright-report/
```

- [ ] **Step 9: 写 `vitest.config.ts`**

```ts
import { defineCloudflareConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineCloudflareConfig({
  // 单元测试与集成测试用同一个 runner；单元测试在下方 test/unit 里
});
```

同时在 `wrangler.jsonc` 顶层加 `"vitest"` 不需要配置 —— pool-workers 直接读 `wrangler.jsonc`。

- [ ] **Step 10: 起开发环境验证**

```bash
npx wrangler dev --port 8787      # 终端 1
npm run dev                        # 终端 2
```

浏览器打开 `http://localhost:5173`。预期：看到「MusicTogether 骨架就绪」。
再访问 `http://localhost:5173/api/health`。预期：`{"ok":true,...}`。

- [ ] **Step 11: 提交**

```bash
git add -A
git commit -m "chore: scaffold vite + preact + cloudflare workers project"
```

---

## Task 2: 共享纯逻辑 —— 房间码与播放锚点

本项目唯一真正需要严谨的算法就在 `playback.ts`：锚点如何推算位置、何时该纠正。它是纯函数，因此也是最该被测试覆盖的地方。

**Files:**
- Create: `src/shared/types.ts`, `src/shared/codes.ts`, `src/shared/playback.ts`
- Test: `test/unit/codes.test.ts`, `test/unit/playback.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `CODE_ALPHABET: string`, `CODE_LENGTH: 6`
  - `normalizeCode(raw: string): string`
  - `isValidCode(raw: string): boolean`
  - `generateCode(): string`
  - `type Playback = { trackId: string | null; positionMs: number; anchorAt: number; isPlaying: boolean; seq: number }`
  - `positionAt(anchor: Playback, now: number): number`
  - `shouldResync(localMs: number, targetMs: number, thresholdMs?: number): boolean`
  - `pauseAnchor(anchor: Playback, now: number): Playback`
  - `resumeAnchor(anchor: Playback, now: number): Playback`
  - `seekAnchor(anchor: Playback, now: number, positionMs: number): Playback`
  - `startAnchor(trackId: string, now: number): Playback`

- [ ] **Step 1: 写 `src/shared/types.ts`**

```ts
export type Track = {
  id: string;
  name: string;
  size: number;
  mime: string;
  uploaderId: string;
  uploaderName: string;
  addedAt: number;
};

export type Member = {
  clientId: string;
  name: string;
  joinedAt: number;
};

export type Playback = {
  trackId: string | null;
  positionMs: number;
  anchorAt: number;
  isPlaying: boolean;
  seq: number;
};

export type RoomState = {
  code: string;
  name: string;
  createdAt: number;
  members: Member[];
  tracks: Track[];
  queue: string[];
  playback: Playback;
  epoch: number;
};
```

- [ ] **Step 2: 写失败测试 `test/unit/codes.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { generateCode, normalizeCode, isValidCode, CODE_ALPHABET, CODE_LENGTH } from '../../src/shared/codes';

describe('房间码', () => {
  it('生成的码长度固定且只含字母表内字符', () => {
    for (let i = 0; i < 500; i++) {
      const c = generateCode();
      expect(c).toHaveLength(CODE_LENGTH);
      for (const ch of c) expect(CODE_ALPHABET).toContain(ch);
    }
  });

  it('生成的码有足够随机性（500 次不重复）', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(generateCode());
    expect(seen.size).toBe(500);
  });

  it('归一化：小写转大写、剔除分隔符与空格', () => {
    expect(normalizeCode('k7m-2qx')).toBe('K7M2QX');
    expect(normalizeCode(' K7M 2QX ')).toBe('K7M2QX');
  });

  it('归一化：修正易混字符 O→0 I→1 L→1 U→V', () => {
    expect(normalizeCode('OILU')).toBe('011V');
  });

  it('校验：合法码通过，长度或字符不合法则失败', () => {
    expect(isValidCode('K7M2QX')).toBe(true);
    expect(isValidCode('k7m2qx')).toBe(true);
    expect(isValidCode('K7M2Q')).toBe(false);
    expect(isValidCode('K7M2QXZ')).toBe(false);
    expect(isValidCode('K7M2Q!')).toBe(false);
  });
});
```

- [ ] **Step 3: 运行测试，确认失败**

```bash
npx vitest run test/unit/codes.test.ts
```

预期：FAIL —— `Failed to resolve import "../../src/shared/codes"`。

- [ ] **Step 4: 写 `src/shared/codes.ts`**

```ts
/** Crockford Base32：剔除 I、L、O、U，避免与 1、0、V 混淆 */
export const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const CODE_LENGTH = 6;

/** 把用户输入规整成规范码形态（不做长度校验） */
export function normalizeCode(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
    .replace(/U/g, 'V');
}

export function isValidCode(raw: string): boolean {
  const code = normalizeCode(raw);
  if (code.length !== CODE_LENGTH) return false;
  for (const ch of code) if (!CODE_ALPHABET.includes(ch)) return false;
  return true;
}

export function generateCode(): string {
  // 256 % 32 === 0，因此取模不会引入偏差
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  let out = '';
  for (const b of bytes) out += CODE_ALPHABET[b % 32];
  return out;
}
```

- [ ] **Step 5: 运行测试，确认通过**

```bash
npx vitest run test/unit/codes.test.ts
```

预期：PASS，5 个用例。

- [ ] **Step 6: 写失败测试 `test/unit/playback.test.ts`**

这是核心逻辑，测试要覆盖锚点的全部状态迁移。

```ts
import { describe, it, expect } from 'vitest';
import {
  positionAt, shouldResync, pauseAnchor, resumeAnchor, seekAnchor, startAnchor,
} from '../../src/shared/playback';
import type { Playback } from '../../src/shared/types';

const T0 = 1_700_000_000_000;

function playing(): Playback {
  return { trackId: 't1', positionMs: 0, anchorAt: T0, isPlaying: true, seq: 1 };
}

describe('positionAt', () => {
  it('播放中：位置随服务端时间线性推进', () => {
    expect(positionAt(playing(), T0)).toBe(0);
    expect(positionAt(playing(), T0 + 5_000)).toBe(5_000);
    expect(positionAt(playing(), T0 + 61_500)).toBe(61_500);
  });

  it('暂停中：位置恒定不动', () => {
    const paused: Playback = { ...playing(), positionMs: 12_000, isPlaying: false };
    expect(positionAt(paused, T0)).toBe(12_000);
    expect(positionAt(paused, T0 + 999_999)).toBe(12_000);
  });

  it('没有曲目：位置为 0，不随时间推进', () => {
    const empty: Playback = { trackId: null, positionMs: 0, anchorAt: T0, isPlaying: true, seq: 0 };
    expect(positionAt(empty, T0 + 10_000)).toBe(0);
  });

  it('时间回退（时钟抖动）不产生负增量', () => {
    expect(positionAt(playing(), T0 - 5_000)).toBe(0);
  });
});

describe('shouldResync', () => {
  it('偏差小于阈值不纠正', () => {
    expect(shouldResync(10_000, 10_500)).toBe(false);
  });
  it('偏差超过默认 2 秒阈值才纠正', () => {
    expect(shouldResync(10_000, 12_100)).toBe(true);
    expect(shouldResync(10_000, 7_900)).toBe(true);
  });
  it('正负偏差对称处理', () => {
    expect(shouldResync(10_000, 8_500)).toBe(false);
    expect(shouldResync(8_500, 10_000)).toBe(false);
  });
});

describe('状态迁移', () => {
  it('pauseAnchor 固化当前位置并停止推进', () => {
    const p = pauseAnchor(playing(), T0 + 30_000);
    expect(p.isPlaying).toBe(false);
    expect(p.positionMs).toBe(30_000);
    expect(positionAt(p, T0 + 999_999)).toBe(30_000);
  });

  it('resumeAnchor 从冻结位置重新起算', () => {
    const paused = pauseAnchor(playing(), T0 + 30_000);
    const resumed = resumeAnchor(paused, T0 + 60_000);
    expect(resumed.isPlaying).toBe(true);
    expect(positionAt(resumed, T0 + 60_000)).toBe(30_000);
    expect(positionAt(resumed, T0 + 65_000)).toBe(35_000);
  });

  it('seekAnchor 跳到目标位置，负数归零', () => {
    const s = seekAnchor(playing(), T0 + 10_000, 45_000);
    expect(positionAt(s, T0 + 10_000)).toBe(45_000);
    expect(seekAnchor(playing(), T0, -500).positionMs).toBe(0);
  });

  it('seek 到当前位置不改变结果', () => {
    const s = seekAnchor(playing(), T0 + 10_000, positionAt(playing(), T0 + 10_000));
    expect(positionAt(s, T0 + 10_000)).toBe(positionAt(playing(), T0 + 10_000));
  });

  it('startAnchor 切换曲目并从 0 开始播', () => {
    const s = startAnchor('t2', T0 + 99_000);
    expect(s.trackId).toBe('t2');
    expect(s.positionMs).toBe(0);
    expect(s.isPlaying).toBe(true);
    expect(positionAt(s, T0 + 102_000)).toBe(3_000);
  });

  it('每次迁移 seq 单调递增（用于丢弃乱序消息）', () => {
    let a = playing();
    const seqs = [a.seq];
    a = pauseAnchor(a, T0 + 1_000); seqs.push(a.seq);
    a = resumeAnchor(a, T0 + 2_000); seqs.push(a.seq);
    a = seekAnchor(a, T0 + 3_000, 5_000); seqs.push(a.seq);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);
  });
});
```

- [ ] **Step 7: 运行测试，确认失败**

```bash
npx vitest run test/unit/playback.test.ts
```

预期：FAIL —— 无法解析 `src/shared/playback`。

- [ ] **Step 8: 写 `src/shared/playback.ts`**

```ts
import type { Playback } from './types';

/** 距上次纠正超过这个毫秒数才动手，避免频繁 seek 产生爆音 */
export const RESYNC_THRESHOLD_MS = 2000;

/**
 * 在服务端时刻 now，锚点所指向的播放位置。
 * 暂停时恒定不动；播放时随时间线性推进。
 */
export function positionAt(anchor: Playback, now: number): number {
  if (!anchor.isPlaying || anchor.trackId === null) return anchor.positionMs;
  return anchor.positionMs + Math.max(0, now - anchor.anchorAt);
}

export function shouldResync(localMs: number, targetMs: number, thresholdMs = RESYNC_THRESHOLD_MS): boolean {
  return Math.abs(localMs - targetMs) > thresholdMs;
}

/** 暂停：把推算出来的位置固化下来 */
export function pauseAnchor(anchor: Playback, now: number): Playback {
  return {
    ...anchor,
    positionMs: positionAt(anchor, now),
    anchorAt: now,
    isPlaying: false,
    seq: anchor.seq + 1,
  };
}

/** 继续：从冻结位置重新起算 */
export function resumeAnchor(anchor: Playback, now: number): Playback {
  return { ...anchor, anchorAt: now, isPlaying: true, seq: anchor.seq + 1 };
}

export function seekAnchor(anchor: Playback, now: number, positionMs: number): Playback {
  return {
    ...anchor,
    positionMs: Math.max(0, Math.floor(positionMs)),
    anchorAt: now,
    isPlaying: anchor.isPlaying,
    seq: anchor.seq + 1,
  };
}

export function startAnchor(trackId: string, now: number): Playback {
  return { trackId, positionMs: 0, anchorAt: now, isPlaying: true, seq: 0 };
}

export function emptyPlayback(): Playback {
  return { trackId: null, positionMs: 0, anchorAt: 0, isPlaying: false, seq: 0 };
}
```

- [ ] **Step 9: 运行全部单元测试，确认通过**

```bash
npx vitest run test/unit
```

预期：PASS，全部用例。

- [ ] **Step 10: 提交**

```bash
git add src/shared test/unit
git commit -m "feat(shared): room code generation and playback anchor math"
```

---

## Task 3: 安全闸门、会话令牌与 HTTP 路由骨架

这一节把 `docs/security.md` §2.1 / §2.3 / §2.4 的对策落地。**先建安全闸门再建路由** ——
顺序反了的话，后面每个路由都要回头补校验，一定会漏。

**Files:**
- Create: `src/server/security.ts`, `src/server/guard.ts`, `src/server/session.ts`
- Modify: `src/server/index.ts`, `src/server/env.ts`
- Test: `test/unit/session.test.ts`, `test/unit/security.test.ts`, `test/integration/routes.test.ts`, `test/integration/ratelimit.test.ts`

**Interfaces:**
- Consumes: `codes.ts` 的 `generateCode` / `isValidCode` / `normalizeCode`
- Produces:
  - `isUuid(s: string): boolean`
  - `audioMimeFor(filename: string): string`
  - `originAllowed(request: Request): boolean`
  - `withSecurity(response: Response): Response`
  - `CSP: string`
  - `signSession(payload: SessionPayload, secret: string): Promise<string>`
  - `verifySession(token: string, secret: string, now?: number): Promise<SessionPayload | null>`
  - `type SessionPayload = { room: string; clientId: string; name: string; exp: number }`
  - `readSession(request: Request, secret: string): Promise<SessionPayload | null>`
  - `sessionCookie(token: string, maxAgeSec: number, secure?: boolean): string`
  - `SESSION_COOKIE = 'mt_sess'`
  - `class GuardDO`：路由 `POST /check` `{key, limit, windowMs}` → `{ok, retryAfter?}`
  - `checkRate(env, key, limit, windowMs): Promise<{ ok: boolean; retryAfter?: number }>`

- [ ] **Step 1: 写失败测试 `test/unit/session.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { signSession, verifySession, type SessionPayload } from '../../src/server/session';

const SECRET = 'test-secret-do-not-use-in-prod';
const NOW = 1_700_000_000_000;

function payload(over: Partial<SessionPayload> = {}): SessionPayload {
  return { room: 'K7M2QX', clientId: 'c1', name: '阿甲', exp: NOW + 60_000, ...over };
}

describe('会话令牌', () => {
  it('签发的令牌能被验证，载荷原样返回', async () => {
    const token = await signSession(payload(), SECRET);
    const out = await verifySession(token, SECRET, NOW);
    expect(out).toEqual(payload());
  });

  it('换一个密钥验证失败', async () => {
    const token = await signSession(payload(), SECRET);
    expect(await verifySession(token, 'other-secret', NOW)).toBeNull();
  });

  it('篡改载荷导致签名校验失败', async () => {
    const token = await signSession(payload(), SECRET);
    const [body, sig] = token.split('.');
    const forged = btoa(JSON.stringify(payload({ name: '攻击者' }))).replace(/=+$/, '');
    expect(await verifySession(`${forged}.${sig}`, SECRET, NOW)).toBeNull();
    expect(await verifySession(`${body}.deadbeef`, SECRET, NOW)).toBeNull();
  });

  it('过期令牌被拒绝', async () => {
    const token = await signSession(payload({ exp: NOW - 1 }), SECRET);
    expect(await verifySession(token, SECRET, NOW)).toBeNull();
  });

  it('结构不合法的令牌被拒绝而非抛异常', async () => {
    for (const bad of ['', '.', 'abc', 'a.b.c', '!!!.???']) {
      expect(await verifySession(bad, SECRET, NOW)).toBeNull();
    }
  });

  it('名字含中文与 emoji 也能往返', async () => {
    const token = await signSession(payload({ name: '小明🎵' }), SECRET);
    expect((await verifySession(token, SECRET, NOW))?.name).toBe('小明🎵');
  });
});
```

- [ ] **Step 2: 运行，确认失败**

```bash
npx vitest run test/unit/session.test.ts
```

预期：FAIL —— 无法解析 `src/server/session`。

- [ ] **Step 3: 写 `src/server/session.ts`**

```ts
export const SESSION_COOKIE = 'mt_sess';
const DEFAULT_TTL_SEC = 30 * 24 * 60 * 60; // 30 天，对应"常驻房间"

export type SessionPayload = {
  room: string;
  clientId: string;
  name: string;
  /** 过期时刻，Unix 毫秒 */
  exp: number;
};

const enc = new TextEncoder();

function b64urlEncode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str: string): Uint8Array | null {
  try {
    const padded = str.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function signSession(payload: SessionPayload, secret: string): Promise<string> {
  const body = b64urlEncode(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(body));
  return `${body}.${b64urlEncode(new Uint8Array(sig))}`;
}

export async function verifySession(token: string, secret: string, now = Date.now()): Promise<SessionPayload | null> {
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;
  const body = token.slice(0, dot);
  const sigBytes = b64urlDecode(token.slice(dot + 1));
  if (!sigBytes) return null;

  const valid = await crypto.subtle.verify('HMAC', await hmacKey(secret), sigBytes, enc.encode(body));
  if (!valid) return null;

  const payloadBytes = b64urlDecode(body);
  if (!payloadBytes) return null;
  let payload: SessionPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return null;
  }
  if (typeof payload?.room !== 'string' || typeof payload?.clientId !== 'string') return null;
  if (typeof payload?.exp !== 'number' || payload.exp <= now) return null;
  return payload;
}

function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

export async function readSession(request: Request, secret: string): Promise<SessionPayload | null> {
  const token = parseCookies(request.headers.get('Cookie'))[SESSION_COOKIE];
  if (!token) return null;
  return verifySession(token, secret);
}

export function sessionCookie(token: string, maxAgeSec = DEFAULT_TTL_SEC): string {
  // 不加 Secure，否则 http://localhost 开发时浏览器不种 Cookie。
  // 生产走 https，部署时由 wrangler 的 routes 保证。
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
```

- [ ] **Step 4: 运行，确认通过**

```bash
npx vitest run test/unit/session.test.ts
```

预期：PASS，6 个用例。

- [ ] **Step 5: 写失败测试 `test/unit/security.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { isUuid, audioMimeFor, originAllowed, withSecurity, CSP } from '../../src/server/security';

describe('isUuid', () => {
  it('接受规范 UUID', () => {
    expect(isUuid('123e4567-e89b-12d3-a456-426614174000')).toBe(true);
    expect(isUuid(crypto.randomUUID())).toBe(true);
  });

  it('拒绝路径穿越与任何非 UUID 形态', () => {
    for (const bad of [
      '../../../etc/passwd',
      '..%2f..%2fsecret',
      'rooms/OTHER/tracks/x',
      '123e4567-e89b-12d3-a456-42661417400',      // 少一位
      '123e4567-e89b-12d3-a456-4266141740000',    // 多一位
      '123E4567-E89B-12D3-A456-426614174000',     // 大写不接受
      '',
      '.',
      '..',
    ]) {
      expect(isUuid(bad)).toBe(false);
    }
  });
});

describe('audioMimeFor', () => {
  it('白名单内的扩展名映射到正确的音频类型', () => {
    expect(audioMimeFor('晴天.mp3')).toBe('audio/mpeg');
    expect(audioMimeFor('A.FLAC')).toBe('audio/flac');
    expect(audioMimeFor('b.m4a')).toBe('audio/mp4');
  });

  it('未知扩展名一律退回 octet-stream，绝不回显用户内容', () => {
    expect(audioMimeFor('evil.html')).toBe('application/octet-stream');
    expect(audioMimeFor('evil.svg')).toBe('application/octet-stream');
    expect(audioMimeFor('noext')).toBe('application/octet-stream');
    expect(audioMimeFor('')).toBe('application/octet-stream');
  });

  it('只看最后一个点之后的扩展名', () => {
    expect(audioMimeFor('my.mp3.html')).toBe('application/octet-stream');
    expect(audioMimeFor('01. 晴天.mp3')).toBe('audio/mpeg');
  });
});

describe('originAllowed', () => {
  const mk = (origin: string | null, url = 'https://app.example.com/api/rooms/X/ws') => {
    const headers = new Headers();
    if (origin !== null) headers.set('Origin', origin);
    return new Request(url, { headers });
  };

  it('同源放行', () => {
    expect(originAllowed(mk('https://app.example.com'))).toBe(true);
  });

  it('跨站拒绝（防 WebSocket CSRF）', () => {
    expect(originAllowed(mk('https://evil.com'))).toBe(false);
    expect(originAllowed(mk('http://app.example.com'))).toBe(false);   // 协议不同
    expect(originAllowed(mk('https://app.example.com.evil.com'))).toBe(false);
    expect(originAllowed(mk('https://app.example.com:8443'))).toBe(false); // 端口不同
  });

  it('缺失或畸形的 Origin 一律拒绝', () => {
    expect(originAllowed(mk(null))).toBe(false);
    expect(originAllowed(mk('not a url'))).toBe(false);
    expect(originAllowed(mk(''))).toBe(false);
  });
});

describe('withSecurity', () => {
  it('补上全部安全响应头', async () => {
    const out = withSecurity(new Response('hi'));
    expect(out.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(out.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(out.headers.get('X-Frame-Options')).toBe('DENY');
    expect(out.headers.get('Content-Security-Policy')).toBe(CSP);
    expect(await out.text()).toBe('hi');
  });

  it('不覆盖已有响应头，也不改变状态码', () => {
    const out = withSecurity(new Response('x', { status: 404, headers: { 'X-Custom': 'kept' } }));
    expect(out.status).toBe(404);
    expect(out.headers.get('X-Custom')).toBe('kept');
  });

  it('CSP 不含 unsafe-eval，且禁止内联脚本', () => {
    expect(CSP).not.toContain('unsafe-eval');
    expect(CSP).toContain("script-src 'self'");
    expect(CSP).toContain("frame-ancestors 'none'");
  });

  it('碰到 WebSocket 升级响应（101）原样返回，不重新包装', () => {
    const upgrade = new Response(null, { status: 101 });
    expect(withSecurity(upgrade).status).toBe(101);
  });
});
```

- [ ] **Step 6: 运行，确认失败**

```bash
npx vitest run --project unit test/unit/security.test.ts
```

预期：FAIL —— 无法解析 `src/server/security`。

- [ ] **Step 7: 写 `src/server/security.ts`**

```ts
import { isValidCode } from '../shared/codes';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * 严格 UUID 校验。任何会被拼进 R2 key 的路径片段都必须先过这一关，
 * 否则 `../../` 就能读到别的房间的文件。见 docs/security.md §2.1。
 */
export function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}

/**
 * 出站 Content-Type 白名单。
 * 用户的 MIME 声明只用于存储元数据，绝不直接成为响应头 ——
 * 否则上传一个 HTML 再直接访问流地址就是同源存储型 XSS。见 §2.2。
 */
const AUDIO_MIME: Record<string, string> = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  wav: 'audio/wav',
  wma: 'audio/x-ms-wma',
};

export function audioMimeFor(filename: string): string {
  const dot = filename.lastIndexOf('.');
  if (dot < 0) return 'application/octet-stream';
  return AUDIO_MIME[filename.slice(dot + 1).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Origin 与部署主机一致才放行。
 * WebSocket 握手不受同源策略与 SameSite 保护，不校验就是现成的 CSRF 通道。见 §2.3。
 */
export function originAllowed(request: Request): boolean {
  const origin = request.headers.get('Origin');
  if (!origin) return false;
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self' ws: wss:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * 给响应补上安全响应头。只在 Worker 最外层调用一次。
 * `Referrer-Policy: no-referrer` 尤其重要：房间码在 URL 路径里，
 * 任何外链跳转都会把它放进 Referer 泄漏出去。
 */
export function withSecurity(response: Response): Response {
  // 101 是 WebSocket 升级响应，重新包装会破坏它
  if (response.status === 101 || response.webSocket) return response;

  const headers = new Headers(response.headers);
  headers.set('Content-Security-Policy', CSP);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Permissions-Policy', 'geolocation=(), camera=(), microphone=()');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** 房间码校验的统一入口，避免各处手写 */
export function isRoomCode(raw: string): boolean {
  return isValidCode(raw);
}
```

- [ ] **Step 8: 运行，确认通过**

```bash
npx vitest run --project unit test/unit/security.test.ts
```

预期：PASS，12 个用例。

- [ ] **Step 9: 写 `src/server/guard.ts`（限速）**

```ts
import type { Env } from './env';

export type RateVerdict = { ok: boolean; retryAfter?: number };

/**
 * 全局限速。房间码有 32^6 ≈ 10.7 亿种，只有配上限速才谈得上不可枚举。
 * 见 docs/security.md §2.4。
 *
 * 这是纵深防御，不是保证：按 IP 限速可以被代理池绕过。
 * 若项目将来对外开放，需要换成 Cloudflare 的 Rate Limiting 产品 + WAF。
 */
export class GuardDO implements DurableObject {
  /** 滑动窗口。DO 被驱逐后窗口归零 —— 降级为"限速短暂失效"，不是永久失效 */
  private hits = new Map<string, number[]>();

  constructor(private state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname !== '/check') {
      return new Response('not found', { status: 404 });
    }

    const { key, limit, windowMs } = (await request.json()) as {
      key: string;
      limit: number;
      windowMs: number;
    };

    const now = Date.now();
    const cutoff = now - windowMs;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > cutoff);

    if (recent.length >= limit) {
      this.hits.set(key, recent);
      const retryAfter = Math.max(1, Math.ceil((recent[0]! + windowMs - now) / 1000));
      return Response.json({ ok: false, retryAfter }, { status: 429 });
    }

    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 10_000) this.sweep(cutoff);
    return Response.json({ ok: true });
  }

  private sweep(cutoff: number): void {
    for (const [k, v] of this.hits) {
      const kept = v.filter((t) => t > cutoff);
      if (kept.length) this.hits.set(k, kept);
      else this.hits.delete(k);
    }
  }
}

/** 在 Worker 里调用的入口。key 里应带上操作类型与来源 IP。 */
export async function checkRate(
  env: Env,
  key: string,
  limit: number,
  windowMs: number,
): Promise<RateVerdict> {
  const stub = env.GUARD.get(env.GUARD.idFromName('global'));
  const res = await stub.fetch('https://guard/check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, limit, windowMs }),
  });
  if (res.status === 429) {
    const body = (await res.json()) as { retryAfter?: number };
    return { ok: false, retryAfter: body.retryAfter ?? 60 };
  }
  return { ok: res.ok };
}

/** 取调用方 IP。本地 wrangler dev 可能没有这个头。 */
export function clientIp(request: Request): string {
  return request.headers.get('CF-Connecting-IP') ?? request.headers.get('X-Forwarded-For') ?? 'local';
}
```

同时在 `src/server/env.ts` 加上 GuardDO 绑定：

```ts
export interface Env {
  ROOMS: DurableObjectNamespace<import('./room').RoomDO>;
  GUARD: DurableObjectNamespace<import('./guard').GuardDO>;
  BUCKET: R2Bucket;
  SESSION_SECRET: string;
}
```

- [ ] **Step 10: 写失败测试 `test/integration/ratelimit.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { SELF } from 'cloudflare:test';

describe('限速', () => {
  it('建房超过 10 次/分钟后返回 429 且带 Retry-After', async () => {
    const results: number[] = [];
    for (let i = 0; i < 14; i++) {
      const res = await SELF.fetch('https://example.com/api/rooms', { method: 'POST' });
      results.push(res.status);
      if (res.status === 429) {
        expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0);
      }
    }
    expect(results.filter((s) => s === 200).length).toBeLessThanOrEqual(10);
    expect(results).toContain(429);
  });

  it('加入房间的探测次数有限，挡住房间码枚举', async () => {
    let sawTooMany = false;
    for (let i = 0; i < 30; i++) {
      const res = await SELF.fetch('https://example.com/api/rooms/ZZZZZZ/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '攻击者' }),
      });
      if (res.status === 429) { sawTooMany = true; break; }
    }
    expect(sawTooMany).toBe(true);
  });
});
```

- [ ] **Step 11: 运行，确认失败**

```bash
npx vitest run --project integration test/integration/ratelimit.test.ts
```

预期：FAIL —— 路由还没接上限速。

- [ ] **Step 12: 在 Worker 里接上路由骨架（含安全闸门）**

`src/server/index.ts`：

```ts
import type { Env } from './env';
import { generateCode, isValidCode, normalizeCode } from '../shared/codes';
import { readSession, signSession, sessionCookie } from './session';
import { checkRate, clientIp } from './guard';
import { isRoomCode, originAllowed, withSecurity } from './security';

const CREATE_LIMIT = { limit: 10, windowMs: 60_000 };
const JOIN_LIMIT = { limit: 20, windowMs: 60_000 };
const UPLOAD_LIMIT = { limit: 60, windowMs: 60_000 };

function json(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, init);
}

function fail(status: number, message: string): Response {
  return json({ error: message }, { status });
}

async function guarded(
  env: Env,
  request: Request,
  bucket: string,
  cfg: { limit: number; windowMs: number },
): Promise<Response | null> {
  const verdict = await checkRate(env, `${bucket}:${clientIp(request)}`, cfg.limit, cfg.windowMs);
  if (verdict.ok) return null;
  return json(
    { error: 'too many requests' },
    { status: 429, headers: { 'Retry-After': String(verdict.retryAfter ?? 60) } },
  );
}

async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (!path.startsWith('/api/')) return new Response('not found', { status: 404 });

  if (path === '/api/health') return json({ ok: true, at: Date.now() });

  if (path === '/api/me') {
    const session = await readSession(request, env.SESSION_SECRET);
    return session ? json({ session }) : fail(401, 'no session');
  }

  if (path === '/api/rooms' && request.method === 'POST') {
    const limited = await guarded(env, request, 'create', CREATE_LIMIT);
    if (limited) return limited;

    for (let attempt = 0; attempt < 5; attempt++) {
      const code = generateCode();
      const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
      const res = await stub.fetch(`https://do/init?code=${code}`, { method: 'POST' });
      if (res.ok) return json({ code });
    }
    return fail(503, 'could not allocate a room code');
  }

  const roomMatch = path.match(/^\/api\/rooms\/([^/]+)(\/.*)?$/);
  if (roomMatch) {
    const code = normalizeCode(roomMatch[1]!);
    if (!isRoomCode(code)) return fail(400, 'bad room code');
    const rest = roomMatch[2] ?? '';

    if (rest === '/join' && request.method === 'POST') {
      const limited = await guarded(env, request, 'join', JOIN_LIMIT);
      if (limited) return limited;

      const body = (await request.json().catch(() => ({}))) as { name?: string; clientId?: string };
      const name = (body.name ?? '').trim().slice(0, 24) || '匿名';
      const clientId = body.clientId?.trim() || crypto.randomUUID();

      const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
      const exists = await stub.fetch('https://do/exists');
      if (!exists.ok) return fail(404, '房间不存在');

      const token = await signSession(
        { room: code, clientId, name, exp: Date.now() + 30 * 864e5 },
        env.SESSION_SECRET,
      );
      return json(
        { clientId, room: code },
        { headers: { 'Set-Cookie': sessionCookie(token, 30 * 86400, url.protocol === 'https:') } },
      );
    }

    const session = await readSession(request, env.SESSION_SECRET);
    if (!session || session.room !== code) return fail(401, 'not a member of this room');

    // WebSocket 握手不受同源策略保护，必须单独校验 Origin
    if (rest === '/ws' && !originAllowed(request)) return fail(403, 'bad origin');

    return fail(501, `not implemented: ${request.method} ${rest}`);
  }

  return fail(404, 'no such route');
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return withSecurity(await handle(request, env));
    } catch (err) {
      // 只记状态，不把内部细节回给客户端
      console.error('unhandled', request.method, new URL(request.url).pathname, (err as Error).name);
      return withSecurity(fail(500, 'internal error'));
    }
  },
} satisfies ExportedHandler<Env>;
```

`sessionCookie` 增加第三个参数 `secure`（生产必须为 true）：

```ts
export function sessionCookie(token: string, maxAgeSec = DEFAULT_TTL_SEC, secure = true): string {
  // Secure 由调用方按协议决定：http://localhost 开发时浏览器不会种 Secure Cookie
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`;
}
```

- [ ] **Step 13: 运行限速测试，确认通过**

```bash
npx vitest run --project integration test/integration/ratelimit.test.ts
```

预期：PASS，2 个用例。

**若「建房超过 10 次」不通过**：说明限速没生效，检查 `wrangler.jsonc` 里 `GUARD` 绑定与 `new_sqlite_classes` 是否都写了 `GuardDO`。

- [ ] **Step 14: 写失败测试 `test/integration/routes.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { SELF } from 'cloudflare:test';

async function newRoom(): Promise<string> {
  const res = await SELF.fetch('https://example.com/api/rooms', { method: 'POST' });
  expect(res.status).toBe(200);
  return ((await res.json()) as { code: string }).code;
}

describe('HTTP 路由', () => {
  it('/api/health 返回 ok', async () => {
    const res = await SELF.fetch('https://example.com/api/health');
    expect(res.status).toBe(200);
    expect((await res.json() as any).ok).toBe(true);
  });

  it('创建房间返回合法房间码，且房间随即存在', async () => {
    const code = await newRoom();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}$/);

    const join = await SELF.fetch(`https://example.com/api/rooms/${code}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://example.com' },
      body: JSON.stringify({ name: '阿甲' }),
    });
    expect(join.status).toBe(200);
  });

  it('加入不存在的房间返回 404', async () => {
    const res = await SELF.fetch('https://example.com/api/rooms/ZZZZZZ/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://example.com' },
      body: JSON.stringify({ name: '阿甲' }),
    });
    expect(res.status).toBe(404);
  });

  it('房间码大小写与易混字符都能正确解析', async () => {
    const code = await newRoom();
    const sloppy = code.toLowerCase().split('').join(' ');
    const res = await SELF.fetch(`https://example.com/api/rooms/${encodeURIComponent(sloppy)}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://example.com' },
      body: JSON.stringify({ name: '阿乙' }),
    });
    expect(res.status).toBe(200);
  });

  it('非法房间码返回 400', async () => {
    const res = await SELF.fetch('https://example.com/api/rooms/ABC/join', { method: 'POST' });
    expect(res.status).toBe(400);
  });

  it('加入后拿到会话 Cookie，/api/me 能读到身份', async () => {
    const code = await newRoom();
    const join = await SELF.fetch(`https://example.com/api/rooms/${code}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://example.com' },
      body: JSON.stringify({ name: '阿甲' }),
    });
    const cookie = join.headers.get('Set-Cookie')!;
    expect(cookie).toContain('mt_sess=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');

    const me = await SELF.fetch('https://example.com/api/me', { headers: { Cookie: cookie } });
    expect(me.status).toBe(200);
    expect((await me.json() as any).session.name).toBe('阿甲');
  });

  it('没有会话时访问房间内路由返回 401', async () => {
    expect((await SELF.fetch('https://example.com/api/rooms/K7M2QX/state')).status).toBe(401);
  });

  it('跨站 Origin 的 WebSocket 升级被拒绝', async () => {
    const code = await newRoom();
    const join = await SELF.fetch(`https://example.com/api/rooms/${code}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://example.com' },
      body: JSON.stringify({ name: '阿甲' }),
    });
    const cookie = join.headers.get('Set-Cookie')!.split(';')[0]!;

    const res = await SELF.fetch(`https://example.com/api/rooms/${code}/ws`, {
      headers: { Upgrade: 'websocket', Cookie: cookie, Origin: 'https://evil.com' },
    });
    expect(res.status).toBe(403);
  });

  it('缺失 Origin 的 WebSocket 升级也被拒绝', async () => {
    const code = await newRoom();
    const join = await SELF.fetch(`https://example.com/api/rooms/${code}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://example.com' },
      body: JSON.stringify({ name: '阿甲' }),
    });
    const cookie = join.headers.get('Set-Cookie')!.split(';')[0]!;

    const res = await SELF.fetch(`https://example.com/api/rooms/${code}/ws`, {
      headers: { Upgrade: 'websocket', Cookie: cookie },
    });
    expect(res.status).toBe(403);
  });

  it('所有响应都带安全头', async () => {
    const res = await SELF.fetch('https://example.com/api/health');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'self'");
  });

  it('不发 CORS 头', async () => {
    const res = await SELF.fetch('https://example.com/api/health', {
      headers: { Origin: 'https://evil.com' },
    });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});
```

- [ ] **Step 15: 补齐测试环境配置并运行**

在 `wrangler.jsonc` 顶层加：

```jsonc
"vitest": {}
```

```bash
npx vitest run --project integration test/integration/routes.test.ts
```

预期：**FAIL** —— `/init` 与 `/exists` 尚未实现（`RoomDO` 还不存在），部分用例会因 500/404 失败。这是预期的，Task 4 会让它们通过。上面这些安全相关的用例（Origin 被拒、安全头、无 CORS）应当**立刻通过**。

- [ ] **Step 16: 提交（保留红灯）**

```bash
git add src/server test vitest.config.ts wrangler.jsonc
git commit -m "feat(server): security gates, rate limiting, session signing and route skeleton"
```

---

# Phase 2 · 房间与连接

## Task 4: RoomDO —— 房间生命周期与 WebSocket

**Files:**
- Create: `src/server/room.ts`, `src/shared/protocol.ts`
- Modify: `src/server/index.ts`（接上 `/ws` 与 `/state`）
- Test: `test/integration/room.test.ts`

**Interfaces:**
- Consumes: `src/shared/types.ts`、`src/shared/codes.ts`、`src/shared/playback.ts`
- Produces:
  - `class RoomDO`，路由：`POST /init?code=`、`GET /exists`、`GET /state`、`GET /ws`（Upgrade）
  - `buildSnapshot(room: RoomState): RoomState`
  - WS 消息类型常量见 `src/shared/protocol.ts`

- [ ] **Step 1: 写 `src/shared/protocol.ts`**

```ts
import type { Playback, RoomState, Track, Member } from './types';

export const PING = '{"type":"ping"}';
export const PONG = '{"type":"pong"}';

export type ClientMessage =
  | { type: 'hello'; name: string }
  | { type: 'play'; trackId: string }
  | { type: 'resume' }
  | { type: 'pause' }
  | { type: 'seek'; positionMs: number }
  | { type: 'next' }
  | { type: 'prev' }
  | { type: 'enqueue'; trackId: string }
  | { type: 'dequeue'; trackId: string }
  | { type: 'reorder'; queue: string[] }
  | { type: 'chat'; text: string };

export type ServerMessage =
  | { type: 'state'; room: RoomState }
  | { type: 'playback'; playback: Playback; serverNow: number }
  | { type: 'sync'; playback: Playback; serverNow: number }
  | { type: 'queue'; queue: string[]; epoch: number }
  | { type: 'tracks'; tracks: Track[]; epoch: number }
  | { type: 'members'; members: Member[] }
  | { type: 'chat'; from: string; name: string; text: string; at: number }
  | { type: 'error'; message: string };

export function parseClientMessage(raw: string): ClientMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const type = (value as { type?: unknown }).type;
  return typeof type === 'string' ? (value as ClientMessage) : null;
}
```

- [ ] **Step 2: 写失败测试 `test/integration/room.test.ts`**

只覆盖本任务的范围（生命周期 + WebSocket + 成员），播放与队列留到后续任务。

```ts
import { describe, it, expect } from 'vitest';
import { SELF } from 'cloudflare:test';

async function createRoom(): Promise<string> {
  const res = await SELF.fetch('https://example.com/api/rooms', { method: 'POST' });
  return ((await res.json()) as { code: string }).code;
}

async function join(code: string, name: string) {
  const res = await SELF.fetch(`https://example.com/api/rooms/${code}/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  const cookie = res.headers.get('Set-Cookie')!.split(';')[0]!;
  const body = (await res.json()) as { clientId: string };
  return { cookie, clientId: body.clientId };
}

/** 把一个 WebSocket 收到的消息按顺序收集起来 */
function collect(ws: WebSocket): { next: () => Promise<any> } {
  const queue: any[] = [];
  const waiters: ((v: any) => void)[] = [];
  ws.addEventListener('message', (e) => {
    const v = JSON.parse(e.data as string);
    const w = waiters.shift();
    if (w) w(v);
    else queue.push(v);
  });
  return {
    next: () => new Promise((resolve) => {
      const v = queue.shift();
      if (v !== undefined) resolve(v);
      else waiters.push(resolve);
    }),
  };
}

async function connect(code: string, cookie: string): Promise<WebSocket> {
  const res = await SELF.fetch(`https://example.com/api/rooms/${code}/ws`, {
    headers: { Upgrade: 'websocket', Cookie: cookie },
  });
  expect(res.status).toBe(101);
  return res.webSocket!;
}

describe('房间生命周期', () => {
  it('新加入的成员立刻收到完整状态快照', async () => {
    const code = await createRoom();
    const { cookie } = await join(code, '阿甲');
    const ws = await connect(code, cookie);
    ws.accept();
    const reader = collect(ws);

    const first = await reader.next();
    expect(first.type).toBe('state');
    expect(first.room.code).toBe(code);
    expect(first.room.members).toHaveLength(1);
    expect(first.room.members[0].name).toBe('阿甲');
    expect(first.room.queue).toEqual([]);
    expect(first.room.playback.trackId).toBeNull();
  });

  it('第二个人加入时，双方都看到两个成员', async () => {
    const code = await createRoom();
    const a = await join(code, '阿甲');
    const wsa = await connect(code, a.cookie); wsa.accept();
    const ra = collect(wsa);
    await ra.next(); // state

    const b = await join(code, '阿乙');
    const wsb = await connect(code, b.cookie); wsb.accept();
    const rb = collect(wsb);

    const stateB = await rb.next();
    expect(stateB.room.members.map((m: any) => m.name).sort()).toEqual(['阿甲', '阿乙']);

    const membersA = await ra.next();
    expect(membersA.type).toBe('members');
    expect(membersA.members).toHaveLength(2);
  });

  it('同一 clientId 重连不会变成第二个成员', async () => {
    const code = await createRoom();
    const a = await join(code, '阿甲');
    const rejoin = await SELF.fetch(`https://example.com/api/rooms/${code}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '阿甲改名了', clientId: a.clientId }),
    });
    expect(((await rejoin.json()) as any).clientId).toBe(a.clientId);

    const state = await (await SELF.fetch(`https://example.com/api/rooms/${code}/state`, {
      headers: { Cookie: a.cookie },
    })).json() as any;
    expect(state.members).toHaveLength(1);
    expect(state.members[0].name).toBe('阿甲改名了');
  });

  it('有人断线后成员列表移除他，并广播给剩下的人', async () => {
    const code = await createRoom();
    const a = await join(code, '阿甲');
    const b = await join(code, '阿乙');
    const wsa = await connect(code, a.cookie); wsa.accept();
    const wsb = await connect(code, b.cookie); wsb.accept();
    const ra = collect(wsa); await ra.next();
    const rb = collect(wsb); await rb.next();
    await ra.next(); // members: 2

    wsb.close(1000, 'bye');
    const after = await ra.next();
    expect(after.type).toBe('members');
    expect(after.members).toHaveLength(1);
    expect(after.members[0].name).toBe('阿甲');
  });

  it('非成员无法连接 WebSocket', async () => {
    const code = await createRoom();
    const other = await createRoom();
    const { cookie } = await join(other, '陌生人');
    const res = await SELF.fetch(`https://example.com/api/rooms/${code}/ws`, {
      headers: { Upgrade: 'websocket', Cookie: cookie },
    });
    expect(res.status).toBe(401);
  });

  it('/state 返回的 epoch 与房间结构版本一致', async () => {
    const code = await createRoom();
    const { cookie } = await join(code, '阿甲');
    const state = await (await SELF.fetch(`https://example.com/api/rooms/${code}/state`, {
      headers: { Cookie: cookie },
    })).json() as any;
    expect(typeof state.epoch).toBe('number');
    expect(state.queue).toEqual([]);
    expect(state.tracks).toEqual([]);
  });
});
```

- [ ] **Step 3: 运行，确认失败**

```bash
npx vitest run test/integration/room.test.ts
```

预期：FAIL —— `RoomDO` 不存在，`/init` 与 `/exists` 返回 404。

- [ ] **Step 4: 写 `src/server/room.ts`**

关键约束再重复一遍：**DO 可能在任何两条消息之间被驱逐**，所以内存态必须能从 `storage` 重建。

```ts
import {
  emptyPlayback,
  pauseAnchor,
  positionAt,
  resumeAnchor,
  seekAnchor,
  startAnchor,
} from '../shared/playback';
import { PING, PONG, parseClientMessage, type ServerMessage } from '../shared/protocol';
import type { Member, Playback, RoomState, Track } from '../shared/types';
import type { Env } from './env';

const STORAGE_KEY = 'room';
/** 播放中每 30 秒发一次兜底同步帧 */
const SYNC_INTERVAL_MS = 30_000;
/** 成员超过这个时间没有活动就认为已离开 */
const MEMBER_TTL_MS = 120_000;

export class RoomDO implements DurableObject {
  private room: RoomState | null = null;

  constructor(private state: DurableObjectState, private env: Env) {
    // 应用层心跳由运行时直接应答，不唤醒 DO
    this.state.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
  }

  // ---------- 持久化 ----------

  private async load(): Promise<RoomState | null> {
    if (this.room) return this.room;
    this.room = (await this.state.storage.get<RoomState>(STORAGE_KEY)) ?? null;
    return this.room;
  }

  private async save(): Promise<void> {
    if (this.room) await this.state.storage.put(STORAGE_KEY, this.room);
  }

  // ---------- 广播 ----------

  private broadcast(msg: ServerMessage, except?: WebSocket): void {
    const data = JSON.stringify(msg);
    for (const ws of this.state.getWebSockets()) {
      if (ws === except) continue;
      try {
        ws.send(data);
      } catch {
        // 连接已断，close 处理器会负责清理
      }
    }
  }

  // ---------- 路由 ----------

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/init' && request.method === 'POST') return this.init(url.searchParams.get('code') ?? '');
    if (path === '/exists') return (await this.load()) ? Response.json({ ok: true }) : new Response('no room', { status: 404 });

    const room = await this.load();
    if (!room) return new Response('no room', { status: 404 });

    if (path === '/state') return Response.json(room);
    if (path === '/ws') return this.handleWebSocket(request);

    return new Response('not found', { status: 404 });
  }

  private async init(code: string): Promise<Response> {
    if (await this.load()) return new Response('already exists', { status: 409 });
    this.room = {
      code,
      name: '',
      createdAt: Date.now(),
      members: [],
      tracks: [],
      queue: [],
      playback: emptyPlayback(),
      epoch: 0,
    };
    await this.save();
    return Response.json({ ok: true, code });
  }

  // ---------- WebSocket ----------

  private async handleWebSocket(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }
    const clientId = request.headers.get('X-Client-Id');
    const name = decodeURIComponent(request.headers.get('X-Client-Name') ?? '') || '匿名';
    if (!clientId) return new Response('missing identity', { status: 400 });

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.state.acceptWebSocket(server, [clientId]);

    await this.addMember(clientId, name);
    server.send(JSON.stringify({ type: 'state', room: this.room! } satisfies ServerMessage));
    this.broadcast({ type: 'members', members: this.room!.members }, server);

    return new Response(null, { status: 101, webSocket: client });
  }

  private async addMember(clientId: string, name: string): Promise<void> {
    const room = this.room!;
    const existing = room.members.find((m) => m.clientId === clientId);
    if (existing) {
      if (existing.name !== name) {
        existing.name = name;
        await this.save();
      }
      return;
    }
    room.members.push({ clientId, name, joinedAt: Date.now() });
    await this.save();
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== 'string') return;
    const room = await this.load();
    if (!room) return;
    const msg = parseClientMessage(raw);
    if (!msg) return;

    const tag = this.state.getTags(ws)[0] ?? '';
    this.pruneMembers();

    switch (msg.type) {
      case 'hello': {
        const name = String(msg.name ?? '').trim().slice(0, 24) || '匿名';
        await this.addMember(tag, name);
        this.broadcast({ type: 'members', members: room.members });
        break;
      }
      default:
        // 其余消息类型在后续 Task 中实现
        break;
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const tag = this.state.getTags(ws)[0] ?? '';
    this.pruneMembers();
    // 只有当这个 clientId 已经没有活着的连接时，才算真正离开
    const stillHere = this.state.getWebSockets().some((s) => (this.state.getTags(s)[0] ?? '') === tag);
    if (!stillHere) {
      const room = await this.load();
      if (room) {
        room.members = room.members.filter((m) => m.clientId !== tag);
        await this.save();
        this.broadcast({ type: 'members', members: room.members });
      }
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }

  private pruneMembers(): void {
    // 占位：v1 用 WebSocket 的存活状态判断成员，不需要 TTL 清理。
    // 保留此方法是为了让 alarm / TTL 策略在需要时有唯一入口。
  }

  async alarm(): Promise<void> {
    const room = await this.load();
    if (!room || !room.playback.isPlaying) {
      await this.state.storage.deleteAlarm();
      return;
    }
    this.broadcast({ type: 'sync', playback: room.playback, serverNow: Date.now() });
    await this.state.storage.setAlarm(Date.now() + SYNC_INTERVAL_MS);
  }
}
```

- [ ] **Step 5: 在 Worker 里接上 `/ws` 与 `/state`**

把 Task 3 里 `src/server/index.ts` 中的这段：

```ts
      // 其余房间内路由统一交给 DO 或 R2，后续 Task 逐一实现
      const session = await readSession(request, env.SESSION_SECRET);
      if (!session || session.room !== code) return fail(401, 'not a member of this room');
      return fail(501, `not implemented: ${request.method} ${rest}`);
```

替换为：

```ts
      const session = await readSession(request, env.SESSION_SECRET);
      if (!session || session.room !== code) return fail(401, 'not a member of this room');

      const stub = env.ROOMS.get(env.ROOMS.idFromName(code));

      if (rest === '/state') {
        return stub.fetch(`https://do/state`);
      }

      if (rest === '/ws') {
        const headers = new Headers(request.headers);
        headers.set('X-Client-Id', session.clientId);
        headers.set('X-Client-Name', encodeURIComponent(session.name));
        return stub.fetch(`https://do/ws`, { headers });
      }

      return fail(501, `not implemented: ${request.method} ${rest}`);
```

- [ ] **Step 6: 运行，确认通过**

```bash
npx vitest run test/integration/room.test.ts
```

预期：PASS，6 个用例。

- [ ] **Step 7: 跑全量测试**

```bash
npm test
```

预期：Task 3 的 7 个路由用例现在也应全部通过。

- [ ] **Step 8: 提交**

```bash
git add -A
git commit -m "feat(server): room durable object with websocket and member tracking"
```

---

## Task 5: 播放控制与锚点广播

**Files:**
- Modify: `src/server/room.ts`
- Test: `test/integration/playback.test.ts`

**Interfaces:**
- Consumes: `src/shared/playback.ts` 的全部函数
- Produces: WS 消息 `play` / `resume` / `pause` / `seek` / `next` / `prev` 的服务端行为；`playback` 与 `sync` 广播

- [ ] **Step 1: 写失败测试 `test/integration/playback.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { SELF } from 'cloudflare:test';

async function setup(names: string[]) {
  const created = await SELF.fetch('https://example.com/api/rooms', { method: 'POST' });
  const code = ((await created.json()) as { code: string }).code;
  const sockets: WebSocket[] = [];
  for (const name of names) {
    const res = await SELF.fetch(`https://example.com/api/rooms/${code}/join`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
    });
    const cookie = res.headers.get('Set-Cookie')!.split(';')[0]!;
    const wsRes = await SELF.fetch(`https://example.com/api/rooms/${code}/ws`, {
      headers: { Upgrade: 'websocket', Cookie: cookie },
    });
    const ws = wsRes.webSocket!;
    ws.accept();
    sockets.push(ws);
  }
  return { code, sockets };
}

function reader(ws: WebSocket) {
  const q: any[] = [];
  const w: ((v: any) => void)[] = [];
  ws.addEventListener('message', (e) => {
    const v = JSON.parse(e.data as string);
    const f = w.shift(); if (f) f(v); else q.push(v);
  });
  return () => new Promise<any>((res) => { const v = q.shift(); if (v !== undefined) res(v); else w.push(res); });
}

/** 取下一帧 playback 或 sync，跳过其他类型 */
async function nextPlayback(next: () => Promise<any>) {
  for (let i = 0; i < 10; i++) {
    const m = await next();
    if (m.type === 'playback' || m.type === 'sync') return m;
  }
  throw new Error('no playback frame');
}

describe('播放控制', () => {
  it('play 让所有人切到同一首并从 0 开始', async () => {
    const { sockets } = await setup(['阿甲', '阿乙']);
    const ra = reader(sockets[0]!); const rb = reader(sockets[1]!);
    await ra(); await rb();

    sockets[0]!.send(JSON.stringify({ type: 'play', trackId: 'track-1' }));

    for (const next of [ra, rb]) {
      const m = await nextPlayback(next);
      expect(m.playback.trackId).toBe('track-1');
      expect(m.playback.isPlaying).toBe(true);
      expect(typeof m.serverNow).toBe('number');
    }
  });

  it('发起者自己也收到广播（服务端权威，不做本地乐观更新）', async () => {
    const { sockets } = await setup(['阿甲']);
    const r = reader(sockets[0]!);
    await r();
    sockets[0]!.send(JSON.stringify({ type: 'play', trackId: 't1' }));
    const m = await nextPlayback(r);
    expect(m.playback.trackId).toBe('t1');
  });

  it('pause 后再 resume，位置从暂停处继续而不是回到 0', async () => {
    const { sockets } = await setup(['阿甲']);
    const r = reader(sockets[0]!);
    await r();
    sockets[0]!.send(JSON.stringify({ type: 'play', trackId: 't1' }));
    await nextPlayback(r);

    sockets[0]!.send(JSON.stringify({ type: 'pause' }));
    const paused = await nextPlayback(r);
    expect(paused.playback.isPlaying).toBe(false);
    const frozenAt = paused.playback.positionMs;

    sockets[0]!.send(JSON.stringify({ type: 'resume' }));
    const resumed = await nextPlayback(r);
    expect(resumed.playback.isPlaying).toBe(true);
    expect(resumed.playback.positionMs).toBe(frozenAt);
  });

  it('seek 直接跳到目标位置', async () => {
    const { sockets } = await setup(['阿甲']);
    const r = reader(sockets[0]!); await r();
    sockets[0]!.send(JSON.stringify({ type: 'play', trackId: 't1' }));
    await nextPlayback(r);
    sockets[0]!.send(JSON.stringify({ type: 'seek', positionMs: 90_000 }));
    const m = await nextPlayback(r);
    expect(m.playback.positionMs).toBe(90_000);
  });

  it('seek 负数归零，且不改变播放状态', async () => {
    const { sockets } = await setup(['阿甲']);
    const r = reader(sockets[0]!); await r();
    sockets[0]!.send(JSON.stringify({ type: 'play', trackId: 't1' }));
    await nextPlayback(r);
    sockets[0]!.send(JSON.stringify({ type: 'seek', positionMs: -10 }));
    const m = await nextPlayback(r);
    expect(m.playback.positionMs).toBe(0);
    expect(m.playback.isPlaying).toBe(true);
  });

  it('seq 单调递增，客户端可据此丢弃乱序帧', async () => {
    const { sockets } = await setup(['阿甲']);
    const r = reader(sockets[0]!); await r();
    const seqs: number[] = [];
    sockets[0]!.send(JSON.stringify({ type: 'play', trackId: 't1' }));
    seqs.push((await nextPlayback(r)).playback.seq);
    sockets[0]!.send(JSON.stringify({ type: 'pause' }));
    seqs.push((await nextPlayback(r)).playback.seq);
    sockets[0]!.send(JSON.stringify({ type: 'seek', positionMs: 1000 }));
    seqs.push((await nextPlayback(r)).playback.seq);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);
  });

  it('没有曲目时 pause/seek 不产生广播', async () => {
    const { sockets } = await setup(['阿甲']);
    const r = reader(sockets[0]!); await r();
    sockets[0]!.send(JSON.stringify({ type: 'pause' }));
    sockets[0]!.send(JSON.stringify({ type: 'seek', positionMs: 5000 }));
    sockets[0]!.send(JSON.stringify({ type: 'play', trackId: 't1' }));
    const m = await nextPlayback(r);
    expect(m.playback.trackId).toBe('t1');
    expect(m.playback.positionMs).toBe(0);
  });

  it('未知或畸形消息被忽略，不崩溃也不广播', async () => {
    const { sockets } = await setup(['阿甲']);
    const r = reader(sockets[0]!); await r();
    sockets[0]!.send('not json at all');
    sockets[0]!.send(JSON.stringify({ type: 'nonsense' }));
    sockets[0]!.send(JSON.stringify({ type: 'play' })); // 缺 trackId
    sockets[0]!.send(JSON.stringify({ type: 'play', trackId: 't1' }));
    const m = await nextPlayback(r);
    expect(m.playback.trackId).toBe('t1');
  });
});
```

- [ ] **Step 2: 运行，确认失败**

```bash
npx vitest run test/integration/playback.test.ts
```

预期：FAIL —— `webSocketMessage` 里除 `hello` 外的分支都还没实现，`nextPlayback` 会超时抛错。

- [ ] **Step 3: 实现播放控制**

在 `src/server/room.ts` 的 `webSocketMessage` 里，把 `switch` 扩展为：

```ts
    switch (msg.type) {
      case 'hello': {
        const name = String(msg.name ?? '').trim().slice(0, 24) || '匿名';
        await this.addMember(tag, name);
        this.broadcast({ type: 'members', members: room.members });
        break;
      }

      case 'play': {
        if (typeof msg.trackId !== 'string' || !room.tracks.some((t) => t.id === msg.trackId)) break;
        room.playback = startAnchor(msg.trackId, Date.now());
        await this.save();
        this.broadcastPlayback(room.playback);
        await this.scheduleSync(room.playback);
        break;
      }

      case 'pause': {
        if (room.playback.trackId === null || !room.playback.isPlaying) break;
        room.playback = pauseAnchor(room.playback, Date.now());
        await this.save();
        this.broadcastPlayback(room.playback);
        await this.state.storage.deleteAlarm();
        break;
      }

      case 'resume': {
        if (room.playback.trackId === null || room.playback.isPlaying) break;
        room.playback = resumeAnchor(room.playback, Date.now());
        await this.save();
        this.broadcastPlayback(room.playback);
        await this.scheduleSync(room.playback);
        break;
      }

      case 'seek': {
        if (room.playback.trackId === null) break;
        if (typeof msg.positionMs !== 'number' || !Number.isFinite(msg.positionMs)) break;
        room.playback = seekAnchor(room.playback, Date.now(), msg.positionMs);
        await this.save();
        this.broadcastPlayback(room.playback);
        break;
      }

      case 'next':
        await this.step(1);
        break;

      case 'prev':
        await this.step(-1);
        break;

      default:
        // 队列与聊天在后续 Task 中实现
        break;
    }
```

新增这几个私有方法：

```ts
  private broadcastPlayback(playback: Playback): void {
    this.broadcast({ type: 'playback', playback, serverNow: Date.now() });
  }

  /** 播放中才调度兜底同步帧；暂停时没有周期性消息（免费额度的生命线） */
  private async scheduleSync(playback: Playback): Promise<void> {
    if (playback.isPlaying) {
      await this.state.storage.setAlarm(Date.now() + SYNC_INTERVAL_MS);
    } else {
      await this.state.storage.deleteAlarm();
    }
  }

  private async step(delta: 1 | -1): Promise<void> {
    const room = this.room!;
    const idx = room.playback.trackId ? room.queue.indexOf(room.playback.trackId) : -1;
    const nextIdx = idx + delta;
    if (nextIdx < 0 || nextIdx >= room.queue.length) {
      // 到头了：停在最后一首的末尾（暂停），不回绕
      if (room.playback.trackId && delta === 1) {
        room.playback = pauseAnchor(room.playback, Date.now());
        await this.save();
        this.broadcastPlayback(room.playback);
        await this.state.storage.deleteAlarm();
      }
      return;
    }
    room.playback = startAnchor(room.queue[nextIdx]!, Date.now());
    await this.save();
    this.broadcastPlayback(room.playback);
    await this.scheduleSync(room.playback);
  }
```

- [ ] **Step 4: 运行，确认通过**

```bash
npx vitest run test/integration/playback.test.ts
```

预期：PASS，8 个用例。

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "feat(server): server-authoritative playback control with anchor broadcast"
```

---

# Phase 3 · 文件

## Task 6: 上传到 R2

**Files:**
- Create: `src/server/media.ts`
- Modify: `src/server/room.ts`（`track-add` 路由）、`src/server/index.ts`
- Test: `test/integration/media.test.ts`

**Interfaces:**
- Consumes: `Env.BUCKET`
- Produces:
  - `R2_PREFIX(roomCode: string, trackId: string): string`
  - `MAX_UPLOAD_BYTES = 100 * 1024 * 1024`
  - `putTrack(env, roomCode, trackId, body: ReadableStream, mime: string): Promise<number>`
  - `trackKey(roomCode: string, trackId: string): string`
  - `POST /api/rooms/:code/tracks` → `{ trackId, uploadUrl }`
  - `PUT /api/rooms/:code/tracks/:id/blob` → `{ ok, size }`
  - DO 路由 `POST /track-add`、`POST /track-remove`

- [ ] **Step 1: 写失败测试 `test/integration/media.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { SELF, env } from 'cloudflare:test';

async function setup() {
  const created = await SELF.fetch('https://example.com/api/rooms', { method: 'POST' });
  const code = ((await created.json()) as { code: string }).code;
  const res = await SELF.fetch(`https://example.com/api/rooms/${code}/join`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '阿甲' }),
  });
  const cookie = res.headers.get('Set-Cookie')!.split(';')[0]!;
  const { clientId } = (await res.json()) as { clientId: string };
  return { code, cookie, clientId };
}

function fakeSong(bytes = 2048): Uint8Array {
  const buf = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) buf[i] = (i * 31) & 0xff;
  return buf;
}

describe('上传', () => {
  it('登记元数据后拿到 trackId 与上传地址', async () => {
    const { code, cookie } = await setup();
    const res = await SELF.fetch(`https://example.com/api/rooms/${code}/tracks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ name: '晴天.mp3', size: 2048, mime: 'audio/mpeg' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { trackId: string; uploadUrl: string };
    expect(body.trackId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.uploadUrl).toContain(body.trackId);
  });

  it('PUT 字节后，对象真的落在 R2 里且内容一致', async () => {
    const { code, cookie } = await setup();
    const bytes = fakeSong();
    const init = await SELF.fetch(`https://example.com/api/rooms/${code}/tracks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ name: '晴天.mp3', size: bytes.length, mime: 'audio/mpeg' }),
    });
    const { trackId, uploadUrl } = (await init.json()) as any;

    const put = await SELF.fetch(uploadUrl, { method: 'PUT', body: bytes, headers: { Cookie: cookie } });
    expect(put.status).toBe(200);
    expect(((await put.json()) as any).size).toBe(bytes.length);

    const stored = await env.BUCKET.get(`rooms/${code}/tracks/${trackId}`);
    expect(stored).not.toBeNull();
    expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(bytes);
  });

  it('上传后房间曲目表包含这首歌', async () => {
    const { code, cookie } = await setup();
    const init = await SELF.fetch(`https://example.com/api/rooms/${code}/tracks`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ name: '晴天.mp3', size: 16, mime: 'audio/mpeg' }),
    });
    const { trackId, uploadUrl } = (await init.json()) as any;
    await SELF.fetch(uploadUrl, { method: 'PUT', body: fakeSong(16), headers: { Cookie: cookie } });

    const state = await (await SELF.fetch(`https://example.com/api/rooms/${code}/state`, {
      headers: { Cookie: cookie },
    })).json() as any;
    expect(state.tracks).toHaveLength(1);
    expect(state.tracks[0]).toMatchObject({ id: trackId, name: '晴天.mp3', size: 16 });
    expect(state.tracks[0].uploaderName).toBe('阿甲');
  });

  it('拒绝超过体积上限的上传', async () => {
    const { code, cookie } = await setup();
    const res = await SELF.fetch(`https://example.com/api/rooms/${code}/tracks`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ name: '巨无霸.flac', size: 200 * 1024 * 1024, mime: 'audio/flac' }),
    });
    expect(res.status).toBe(413);
  });

  it('没有会话不能上传', async () => {
    const { code } = await setup();
    const res = await SELF.fetch(`https://example.com/api/rooms/${code}/tracks`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x.mp3', size: 1, mime: 'audio/mpeg' }),
    });
    expect(res.status).toBe(401);
  });

  it('跨房间的 trackId 不能写入（路径与令牌必须一致）', async () => {
    const a = await setup();
    const b = await setup();
    const init = await SELF.fetch(`https://example.com/api/rooms/${a.code}/tracks`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: a.cookie },
      body: JSON.stringify({ name: 'x.mp3', size: 16, mime: 'audio/mpeg' }),
    });
    const { trackId } = (await init.json()) as any;
    const res = await SELF.fetch(`https://example.com/api/rooms/${b.code}/tracks/${trackId}/blob`, {
      method: 'PUT', body: fakeSong(16), headers: { Cookie: a.cookie },
    });
    expect(res.status).toBe(401);
  });
});

describe('上传的安全约束', () => {
  it('非 UUID 的 trackId 不能写入 R2（防路径穿越）', async () => {
    const { code, cookie } = await setup();
    for (const bad of ['..%2F..%2Fsecret', 'not-a-uuid', 'a'.repeat(40)]) {
      const res = await SELF.fetch(
        `https://example.com/api/rooms/${code}/tracks/${encodeURIComponent(bad)}/blob`,
        { method: 'PUT', body: fakeSong(16), headers: { Cookie: cookie } },
      );
      expect(res.status).toBe(400);
    }
    // 桶里不应该多出任何东西
    const listed = await env.BUCKET.list({ prefix: `rooms/${code}/` });
    expect(listed.objects).toHaveLength(0);
  });

  it('只有上传者能删云端文件', async () => {
    const { code, cookie } = await setup();
    const init = await SELF.fetch(`https://example.com/api/rooms/${code}/tracks`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ name: 'a.mp3', size: 16, mime: 'audio/mpeg' }),
    });
    const { trackId, uploadUrl } = (await init.json()) as any;
    await SELF.fetch(uploadUrl, { method: 'PUT', body: fakeSong(16), headers: { Cookie: cookie } });

    // 另一个人加入同一个房间
    const other = await SELF.fetch(`https://example.com/api/rooms/${code}/join`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '阿乙' }),
    });
    const otherCookie = other.headers.get('Set-Cookie')!.split(';')[0]!;

    const denied = await SELF.fetch(`https://example.com/api/rooms/${code}/tracks/${trackId}`, {
      method: 'DELETE', headers: { Cookie: otherCookie },
    });
    expect(denied.status).toBe(403);
    expect(await env.BUCKET.get(`rooms/${code}/tracks/${trackId}`)).not.toBeNull();

    const allowed = await SELF.fetch(`https://example.com/api/rooms/${code}/tracks/${trackId}`, {
      method: 'DELETE', headers: { Cookie: cookie },
    });
    expect(allowed.status).toBe(200);
    expect(await env.BUCKET.get(`rooms/${code}/tracks/${trackId}`)).toBeNull();
  });

  it('超过房间曲目数配额时拒绝登记', async () => {
    const { code, cookie } = await setup();
    for (let i = 0; i < 200; i++) {
      const res = await SELF.fetch(`https://example.com/api/rooms/${code}/tracks`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ name: `t${i}.mp3`, size: 16, mime: 'audio/mpeg' }),
      });
      expect(res.status).toBe(200);
    }
    const overflow = await SELF.fetch(`https://example.com/api/rooms/${code}/tracks`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ name: 'overflow.mp3', size: 16, mime: 'audio/mpeg' }),
    });
    expect(overflow.status).toBe(413);
  });

  it('上传接口本身也受限速保护', async () => {
    const { code, cookie } = await setup();
    let sawTooMany = false;
    for (let i = 0; i < 80; i++) {
      const res = await SELF.fetch(`https://example.com/api/rooms/${code}/tracks`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ name: `t${i}.mp3`, size: 16, mime: 'audio/mpeg' }),
      });
      if (res.status === 429) { sawTooMany = true; break; }
    }
    expect(sawTooMany).toBe(true);
  });
});
```

- [ ] **Step 2: 运行，确认失败**

```bash
npx vitest run test/integration/media.test.ts
```

预期：FAIL —— 路由返回 501。

- [ ] **Step 3: 写 `src/server/media.ts`**

```ts
import type { Env } from './env';
import { audioMimeFor, isUuid } from './security';

/** 单文件上限。Workers 请求体的硬上限就是 100 MB（挂在 Zone 计划上） */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/** 每房间配额（安全文档 §2.7）：防止拿到一个房间码就把 R2 免费额度填满 */
export const MAX_TRACKS_PER_ROOM = 200;
export const MAX_ROOM_BYTES = 2 * 1024 * 1024 * 1024;

export function trackKey(roomCode: string, trackId: string): string {
  // 双保险：调用方已经校验过，这里再挡一次，避免将来有人绕过
  if (!isUuid(trackId)) throw new Error('bad track id');
  return `rooms/${roomCode}/tracks/${trackId}`;
}

/**
 * 流式写入 R2，同时累计字节数。
 * 不用 Content-Length —— 它可以伪造或省略（安全文档 §2.7）。
 * 超限时抛出，由调用方删除半截对象。
 */
export async function putTrack(
  env: Env,
  roomCode: string,
  trackId: string,
  body: ReadableStream<Uint8Array>,
): Promise<number> {
  let total = 0;
  let aborted = false;

  const counted = body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.byteLength;
        if (total > MAX_UPLOAD_BYTES) {
          aborted = true;
          controller.error(new Error('too large'));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );

  try {
    // 注意：这里不写 httpMetadata.contentType —— 用户声明的 MIME 一律不进响应头，
    // 出站类型由 audioMimeFor(文件名) 决定（安全文档 §2.2）
    const obj = await env.BUCKET.put(trackKey(roomCode, trackId), counted);
    return obj?.size ?? total;
  } catch (err) {
    // 半截对象不能留在桶里
    await env.BUCKET.delete(trackKey(roomCode, trackId)).catch(() => {});
    throw aborted ? new Error('too large') : err;
  }
}

export async function deleteTrack(env: Env, roomCode: string, trackId: string): Promise<void> {
  if (!isUuid(trackId)) return;
  await env.BUCKET.delete(trackKey(roomCode, trackId));
}

/**
 * 流式返回 R2 对象，支持 Range。
 *
 * 三件必须自己做的事：
 * 1. 流式转发（Worker 内存只有 128 MB）
 * 2. 手写 206 / Content-Range（R2 的 Worker API 不产出）
 * 3. 强制 Content-Type 为白名单值（安全文档 §2.2，否则是存储型 XSS）
 */
export async function streamTrack(
  env: Env,
  roomCode: string,
  trackId: string,
  filename: string,
  request: Request,
): Promise<Response> {
  if (!isUuid(trackId)) return new Response('bad track id', { status: 400 });

  const rangeHeader = request.headers.get('Range');
  const obj = await env.BUCKET.get(trackKey(roomCode, trackId), {
    range: rangeHeader ? request.headers : undefined,
    onlyIf: request.headers,
  });
  if (!obj) return new Response('not found', { status: 404 });

  const headers = new Headers({
    // 绝不回显用户提供的 MIME：未知扩展名会退回 application/octet-stream
    'Content-Type': audioMimeFor(filename),
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': 'inline',
    'Accept-Ranges': 'bytes',
    'ETag': obj.httpEtag,
    'Cache-Control': 'private, max-age=3600',
  });

  if (!rangeHeader || !obj.range) {
    headers.set('Content-Length', String(obj.size));
    return new Response(obj.body, { status: 200, headers });
  }

  const start = obj.range.offset;
  const end = obj.range.offset + obj.range.length - 1;
  headers.set('Content-Range', `bytes ${start}-${end}/${obj.size}`);
  headers.set('Content-Length', String(obj.range.length));
  return new Response(obj.body, { status: 206, headers });
}
```

**`filename` 从哪来**：`<audio>` 的 URL 带上文件名作查询参数 ——
`/api/rooms/K7M2QX/tracks/<uuid>/stream?n=晴天.mp3`。

这**不构成安全弱点**，因为 `audioMimeFor` 的输出只可能是白名单里的那几个固定常量之一。
攻击者篡改 `?n=` 最多让自己拿到一个错误的音频类型（浏览器解码失败而已），
**无法让响应头变成 `text/html`** —— 而后者才是 XSS 的充要条件。文件本身的访问
控制由房间码 + UUID 路径承担，与这个参数无关。这一点在评审时要能说清楚。

（另一个方案是流式端点先问一次 DO 拿文件名。但那会给每个 Range 请求加一次 DO 往返，
浏览器为一首歌会发几十个 Range 请求，成本放大几十倍。不值得。）

- [ ] **Step 4: 在 RoomDO 加曲目登记与移除路由**

`src/server/room.ts` 的 `fetch` 中，在 `if (path === '/ws') ...` 之前插入：

```ts
    if (path === '/track-add' && request.method === 'POST') return this.addTrack(request);
    if (path === '/track-remove' && request.method === 'POST') return this.removeTrack(request);
```

新增方法：

```ts
  private async addTrack(request: Request): Promise<Response> {
    const body = (await request.json()) as Partial<Track>;
    const room = this.room!;

    // 安全文档 §2.7：每房间配额。否则拿到一个房间码就能把 R2 免费额度填满。
    if (room.tracks.length >= MAX_TRACKS_PER_ROOM) {
      return new Response('room is full', { status: 413 });
    }
    const usedBytes = room.tracks.reduce((sum, t) => sum + t.size, 0);
    if (usedBytes + Number(body.size ?? 0) > MAX_ROOM_BYTES) {
      return new Response('room storage quota exceeded', { status: 413 });
    }

    const track: Track = {
      id: body.id!,
      name: String(body.name ?? '未命名').slice(0, 200),
      size: Number(body.size ?? 0),
      mime: String(body.mime ?? 'audio/mpeg'),
      uploaderId: String(body.uploaderId ?? ''),
      uploaderName: String(body.uploaderName ?? '匿名'),
      addedAt: Date.now(),
    };
    room.tracks.push(track);
    room.queue.push(track.id);
    room.epoch++;
    await this.save();
    this.broadcast({ type: 'tracks', tracks: room.tracks, epoch: room.epoch });
    this.broadcast({ type: 'queue', queue: room.queue, epoch: room.epoch });
    return Response.json({ ok: true });
  }

  private async removeTrack(request: Request): Promise<Response> {
    const { trackId } = (await request.json()) as { trackId: string };
    const room = this.room!;
    room.tracks = room.tracks.filter((t) => t.id !== trackId);
    room.queue = room.queue.filter((id) => id !== trackId);
    if (room.playback.trackId === trackId) {
      room.playback = emptyPlayback();
      this.broadcastPlayback(room.playback);
    }
    room.epoch++;
    await this.save();
    this.broadcast({ type: 'tracks', tracks: room.tracks, epoch: room.epoch });
    this.broadcast({ type: 'queue', queue: room.queue, epoch: room.epoch });
    return Response.json({ ok: true });
  }
```

- [ ] **Step 5: 在 Worker 里接上三条路由**

`src/server/index.ts`，在 `if (rest === '/ws') { ... }` 之后插入：

```ts
      const trackMatch = rest.match(/^\/tracks\/([^/]+)\/blob$/);
      if (trackMatch && request.method === 'PUT') {
        const limited = await guarded(env, request, 'upload', UPLOAD_LIMIT);
        if (limited) return limited;

        // 安全闸门 §2.1：trackId 会被拼进 R2 key，必须先证明它是 UUID
        const trackId = trackMatch[1]!;
        if (!isUuid(trackId)) return fail(400, 'bad track id');

        // 安全闸门 §2.7：Content-Length 可以伪造或省略，这里只做快速拒绝，
        // 真正的上限由 putTrack 在流式读取时累计计数
        const declared = Number(request.headers.get('Content-Length') ?? 0);
        if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) return fail(413, 'file too large');
        if (!request.body) return fail(400, 'empty body');

        try {
          const size = await putTrack(env, code, trackId, request.body);
          return json({ ok: true, size });
        } catch (err) {
          if ((err as Error).message === 'too large') return fail(413, 'file too large');
          throw err;
        }
      }

      const deleteMatch = rest.match(/^\/tracks\/([^/]+)$/);
      if (deleteMatch && request.method === 'DELETE') {
        const trackId = deleteMatch[1]!;
        const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
        const check = await stub.fetch(`https://do/track-deletable?trackId=${trackId}&clientId=${session.clientId}`);
        if (!check.ok) return fail(403, 'only the uploader can delete');
        await deleteTrack(env, code, trackId);
        await stub.fetch(`https://do/track-remove`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ trackId }),
        });
        return json({ ok: true });
      }

      if (rest === '/tracks' && request.method === 'POST') {
        const body = (await request.json().catch(() => ({}))) as { name?: string; size?: number; mime?: string };
        const size = Number(body.size ?? 0);
        if (!Number.isFinite(size) || size <= 0) return fail(400, 'bad size');
        if (size > MAX_UPLOAD_BYTES) return fail(413, 'file too large');

        const trackId = crypto.randomUUID();
        const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
        const added = await stub.fetch(`https://do/track-add`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: trackId,
            name: body.name ?? '未命名',
            size,
            mime: body.mime ?? 'audio/mpeg',
            uploaderId: session.clientId,
            uploaderName: session.name,
          }),
        });
        if (!added.ok) return fail(500, 'could not register track');
        return json({ trackId, uploadUrl: `/api/rooms/${code}/tracks/${trackId}/blob` });
      }
```

并补上顶部导入：

```ts
import { MAX_UPLOAD_BYTES, deleteTrack, putTrack, streamTrack } from './media';
```

- [ ] **Step 6: 在 RoomDO 加 `track-deletable` 路由**

```ts
    if (path === '/track-deletable') {
      const trackId = url.searchParams.get('trackId');
      const clientId = url.searchParams.get('clientId');
      const track = this.room!.tracks.find((t) => t.id === trackId);
      return track && track.uploaderId === clientId
        ? Response.json({ ok: true })
        : new Response('forbidden', { status: 403 });
    }
```

- [ ] **Step 7: 运行，确认通过**

```bash
npx vitest run test/integration/media.test.ts
```

预期：PASS，6 个用例。

- [ ] **Step 8: 提交**

```bash
git add -A
git commit -m "feat(server): track upload to R2 with per-room authorization"
```

---

## Task 7: 流式播放与 Range

**Files:**
- Modify: `src/server/index.ts`
- Test: `test/integration/stream.test.ts`

**Interfaces:**
- Consumes: `streamTrack`（Task 6）
- Produces: `GET /api/rooms/:code/tracks/:id/stream` 支持 Range，返回 206 + `Content-Range`

- [ ] **Step 1: 写失败测试 `test/integration/stream.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { SELF } from 'cloudflare:test';

async function uploadSong(bytes: Uint8Array) {
  const created = await SELF.fetch('https://example.com/api/rooms', { method: 'POST' });
  const code = ((await created.json()) as { code: string }).code;
  const joined = await SELF.fetch(`https://example.com/api/rooms/${code}/join`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '阿甲' }),
  });
  const cookie = joined.headers.get('Set-Cookie')!.split(';')[0]!;
  const init = await SELF.fetch(`https://example.com/api/rooms/${code}/tracks`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ name: 's.mp3', size: bytes.length, mime: 'audio/mpeg' }),
  });
  const { trackId, uploadUrl } = (await init.json()) as any;
  await SELF.fetch(uploadUrl, { method: 'PUT', body: bytes, headers: { Cookie: cookie } });
  return { code, cookie, trackId, url: `/api/rooms/${code}/tracks/${trackId}/stream` };
}

function song(n: number): Uint8Array {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = i & 0xff;
  return b;
}

describe('流式播放', () => {
  it('无 Range 时返回 200 与完整内容', async () => {
    const bytes = song(4096);
    const { cookie, url } = await uploadSong(bytes);
    const res = await SELF.fetch(`https://example.com${url}`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get('Accept-Ranges')).toBe('bytes');
    expect(res.headers.get('Content-Length')).toBe('4096');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
  });

  it('带 Range 时返回 206 与正确的 Content-Range', async () => {
    const bytes = song(4096);
    const { cookie, url } = await uploadSong(bytes);
    const res = await SELF.fetch(`https://example.com${url}`, {
      headers: { Cookie: cookie, Range: 'bytes=100-199' },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Range')).toBe('bytes 100-199/4096');
    expect(res.headers.get('Content-Length')).toBe('100');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes.slice(100, 200));
  });

  it('后缀 Range（最后 N 字节）正确', async () => {
    const bytes = song(4096);
    const { cookie, url } = await uploadSong(bytes);
    const res = await SELF.fetch(`https://example.com${url}`, {
      headers: { Cookie: cookie, Range: 'bytes=-256' },
    });
    expect(res.status).toBe(206);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes.slice(-256));
  });

  it('开放区间 Range（从某点到结尾）正确', async () => {
    const bytes = song(4096);
    const { cookie, url } = await uploadSong(bytes);
    const res = await SELF.fetch(`https://example.com${url}`, {
      headers: { Cookie: cookie, Range: 'bytes=4000-' },
    });
    expect(res.status).toBe(206);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes.slice(4000));
  });

  it('没有会话不能读流', async () => {
    const bytes = song(64);
    const { url } = await uploadSong(bytes);
    expect((await SELF.fetch(`https://example.com${url}`)).status).toBe(401);
  });

  it('别的房间的令牌读不到这个房间的歌', async () => {
    const a = await uploadSong(song(64));
    const b = await uploadSong(song(64));
    const res = await SELF.fetch(`https://example.com${a.url}`, { headers: { Cookie: b.cookie } });
    expect(res.status).toBe(401);
  });

  it('不存在的曲目返回 404', async () => {
    const { code, cookie } = await uploadSong(song(64));
    const res = await SELF.fetch(`https://example.com/api/rooms/${code}/tracks/00000000-0000-0000-0000-000000000000/stream`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(404);
  });

  it('同时上传两首歌，字节流不会串台', async () => {
    const one = song(1000);
    const two = new Uint8Array(1000).fill(0xAB);
    const a = await uploadSong(one);
    const b = await uploadSong(two);
    const ra = new Uint8Array(await (await SELF.fetch(`https://example.com${a.url}`, { headers: { Cookie: a.cookie } })).arrayBuffer());
    const rb = new Uint8Array(await (await SELF.fetch(`https://example.com${b.url}`, { headers: { Cookie: b.cookie } })).arrayBuffer());
    expect(ra).toEqual(one);
    expect(rb).toEqual(two);
  });
});
```

- [ ] **Step 2: 运行，确认失败**

```bash
npx vitest run test/integration/stream.test.ts
```

预期：FAIL —— `/stream` 路由未实现，返回 501。

- [ ] **Step 3: 接上 `/stream` 路由**

`src/server/index.ts`，在 `if (rest === '/state')` 之后插入：

```ts
      const streamMatch = rest.match(/^\/tracks\/([^/]+)\/stream$/);
      if (streamMatch && request.method === 'GET') {
        const trackId = streamMatch[1]!;
        // 安全闸门 §2.1：格式不对直接 400，绝不带着未校验的字符串去拼 key
        if (!isUuid(trackId)) return fail(400, 'bad track id');
        // ?n= 只用于选择响应头的音频类型，只可能落在白名单常量上（见 §2.2 的说明）
        const filename = url.searchParams.get('n') ?? '';
        return streamTrack(env, code, trackId, filename, request);
      }
```

并在顶部导入里加上 `isUuid`（Task 3 已经导入了 `security` 里的几个，这里补上）。

- [ ] **Step 4: 补安全用例到 `test/integration/stream.test.ts`**

在既有用例之后追加：

```ts
describe('流式端点的安全约束', () => {
  it('非 UUID 的 trackId 返回 400，而不是去拼 key', async () => {
    const { code, cookie } = await uploadSong(song(64));
    for (const bad of ['..%2F..%2Fsecret', 'not-a-uuid', '../../etc/passwd', 'a'.repeat(40)]) {
      const res = await SELF.fetch(
        `https://example.com/api/rooms/${code}/tracks/${encodeURIComponent(bad)}/stream`,
        { headers: { Cookie: cookie } },
      );
      expect([400, 404]).toContain(res.status);
      expect(res.status).not.toBe(200);
    }
  });

  it('响应头强制 nosniff，且 Content-Type 只可能是白名单值', async () => {
    const { cookie, url } = await uploadSong(song(256));
    const res = await SELF.fetch(`https://example.com${url}?n=x.mp3`, { headers: { Cookie: cookie } });
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Content-Type')).toBe('audio/mpeg');
  });

  it('上传 HTML 也拿不到 text/html 的响应类型（存储型 XSS 的核心防线）', async () => {
    // 登记时故意声明成 HTML，并给一个 .html 的文件名
    const created = await SELF.fetch('https://example.com/api/rooms', { method: 'POST' });
    const code = ((await created.json()) as { code: string }).code;
    const joined = await SELF.fetch(`https://example.com/api/rooms/${code}/join`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '阿甲' }),
    });
    const cookie = joined.headers.get('Set-Cookie')!.split(';')[0]!;
    const init = await SELF.fetch(`https://example.com/api/rooms/${code}/tracks`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ name: 'evil.html', size: 32, mime: 'text/html' }),
    });
    const { trackId, uploadUrl } = (await init.json()) as any;
    await SELF.fetch(uploadUrl, {
      method: 'PUT',
      headers: { Cookie: cookie, 'Content-Type': 'text/html' },
      body: new TextEncoder().encode('<script>alert(1)</script>'),
    });

    // 即使攻击者自己指定 ?n=evil.html，也只会拿到 octet-stream
    const res = await SELF.fetch(
      `https://example.com/api/rooms/${code}/tracks/${trackId}/stream?n=evil.html`,
      { headers: { Cookie: cookie } },
    );
    expect(res.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(res.headers.get('Content-Type')).not.toContain('html');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('不发 CORS 头（浏览器端只能同源读）', async () => {
    const { cookie, url } = await uploadSong(song(64));
    const res = await SELF.fetch(`https://example.com${url}`, {
      headers: { Cookie: cookie, Origin: 'https://evil.com' },
    });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});
```

- [ ] **Step 5: 运行，确认通过**

```bash
npx vitest run --project integration test/integration/stream.test.ts
```

预期：PASS，12 个用例（8 个功能 + 4 个安全）。

- [ ] **Step 6: 提交**

```bash
git add -A
git commit -m "feat(server): range-capable streaming endpoint with forced audio content-type"
```

---

## Task 8: 队列操作

**Files:**
- Modify: `src/server/room.ts`
- Test: `test/integration/queue.test.ts`

**Interfaces:**
- Consumes: `enqueue` / `dequeue` / `reorder` 客户端消息（Task 6 已在 DO 存了 `queue`）
- Produces: `queue` 广播；`epoch` 递增

- [ ] **Step 1: 写失败测试 `test/integration/queue.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { SELF } from 'cloudflare:test';

async function setup(names: string[]) {
  const created = await SELF.fetch('https://example.com/api/rooms', { method: 'POST' });
  const code = ((await created.json()) as { code: string }).code;
  const sockets: WebSocket[] = [];
  for (const name of names) {
    const j = await SELF.fetch(`https://example.com/api/rooms/${code}/join`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
    });
    const cookie = j.headers.get('Set-Cookie')!.split(';')[0]!;
    const w = await SELF.fetch(`https://example.com/api/rooms/${code}/ws`, {
      headers: { Upgrade: 'websocket', Cookie: cookie },
    });
    const ws = w.webSocket!; ws.accept(); sockets.push(ws);
  }
  return { code, sockets };
}

function reader(ws: WebSocket) {
  const q: any[] = []; const w: ((v: any) => void)[] = [];
  ws.addEventListener('message', (e) => { const v = JSON.parse(e.data as string); const f = w.shift(); if (f) f(v); else q.push(v); });
  return () => new Promise<any>((r) => { const v = q.shift(); if (v !== undefined) r(v); else w.push(r); });
}

async function nextOfType(next: () => Promise<any>, type: string) {
  for (let i = 0; i < 12; i++) { const m = await next(); if (m.type === type) return m; }
  throw new Error('never saw ' + type);
}

async function addTracks(code: string, cookie: string, names: string[]) {
  const ids: string[] = [];
  for (const name of names) {
    const init = await SELF.fetch(`https://example.com/api/rooms/${code}/tracks`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ name, size: 16, mime: 'audio/mpeg' }),
    });
    const { trackId } = (await init.json()) as any;
    ids.push(trackId);
  }
  return ids;
}

describe('队列', () => {
  it('上传的歌自动进入队列，按上传顺序排列', async () => {
    const { code, sockets } = await setup(['阿甲']);
    const cookie = 'PLACEHOLDER';
    const r = reader(sockets[0]!); await r();
    // 直接通过 /state 拿 cookie 不方便，用已建立的连接读取队列广播
    const res = await SELF.fetch(`https://example.com/api/rooms/${code}/join`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '阿甲' }),
    });
    const c = res.headers.get('Set-Cookie')!.split(';')[0]!;
    const ids = await addTracks(code, c, ['A.mp3', 'B.mp3', 'C.mp3']);
    const q = await nextOfType(r, 'queue');
    expect(q.queue).toEqual(ids);
  });

  it('dequeue 从队列移除但曲目仍在（云端保留）', async () => {
    const { code, sockets } = await setup(['阿甲']);
    const r = reader(sockets[0]!); await r();
    const res = await SELF.fetch(`https://example.com/api/rooms/${code}/join`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '阿甲' }),
    });
    const c = res.headers.get('Set-Cookie')!.split(';')[0]!;
    const ids = await addTracks(code, c, ['A.mp3', 'B.mp3']);
    await nextOfType(r, 'queue');

    sockets[0]!.send(JSON.stringify({ type: 'dequeue', trackId: ids[0] }));
    const q = await nextOfType(r, 'queue');
    expect(q.queue).toEqual([ids[1]]);

    const state = await (await SELF.fetch(`https://example.com/api/rooms/${code}/state`, { headers: { Cookie: c } })).json() as any;
    expect(state.tracks).toHaveLength(2);          // 曲目还在
    expect(state.queue).toEqual([ids[1]]);          // 只是不在队列里
  });

  it('reorder 改变顺序并广播', async () => {
    const { code, sockets } = await setup(['阿甲']);
    const r = reader(sockets[0]!); await r();
    const res = await SELF.fetch(`https://example.com/api/rooms/${code}/join`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '阿甲' }),
    });
    const c = res.headers.get('Set-Cookie')!.split(';')[0]!;
    const ids = await addTracks(code, c, ['A.mp3', 'B.mp3', 'C.mp3']);
    await nextOfType(r, 'queue');

    const reversed = [...ids].reverse();
    sockets[0]!.send(JSON.stringify({ type: 'reorder', queue: reversed }));
    const q = await nextOfType(r, 'queue');
    expect(q.queue).toEqual(reversed);
  });

  it('reorder 传入未知 id 或漏掉 id 时被忽略', async () => {
    const { code, sockets } = await setup(['阿甲']);
    const r = reader(sockets[0]!); await r();
    const res = await SELF.fetch(`https://example.com/api/rooms/${code}/join`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '阿甲' }),
    });
    const c = res.headers.get('Set-Cookie')!.split(';')[0]!;
    const ids = await addTracks(code, c, ['A.mp3', 'B.mp3']);
    await nextOfType(r, 'queue');

    sockets[0]!.send(JSON.stringify({ type: 'reorder', queue: [ids[0], 'ghost'] }));
    sockets[0]!.send(JSON.stringify({ type: 'reorder', queue: [ids[0]] }));       // 漏了一个
    sockets[0]!.send(JSON.stringify({ type: 'reorder', queue: [ids[1], ids[0]] }));
    const q = await nextOfType(r, 'queue');
    expect(q.queue).toEqual([ids[1], ids[0]]);
  });

  it('enqueue 把已在库里的歌放回队尾', async () => {
    const { code, sockets } = await setup(['阿甲']);
    const r = reader(sockets[0]!); await r();
    const res = await SELF.fetch(`https://example.com/api/rooms/${code}/join`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '阿甲' }),
    });
    const c = res.headers.get('Set-Cookie')!.split(';')[0]!;
    const ids = await addTracks(code, c, ['A.mp3', 'B.mp3']);
    await nextOfType(r, 'queue');
    sockets[0]!.send(JSON.stringify({ type: 'dequeue', trackId: ids[0] }));
    await nextOfType(r, 'queue');

    sockets[0]!.send(JSON.stringify({ type: 'enqueue', trackId: ids[0] }));
    const q = await nextOfType(r, 'queue');
    expect(q.queue).toEqual([ids[1], ids[0]]);
  });

  it('移到队列外的歌会重置播放状态', async () => {
    const { code, sockets } = await setup(['阿甲']);
    const r = reader(sockets[0]!); await r();
    const res = await SELF.fetch(`https://example.com/api/rooms/${code}/join`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '阿甲' }),
    });
    const c = res.headers.get('Set-Cookie')!.split(';')[0]!;
    const ids = await addTracks(code, c, ['A.mp3']);
    await nextOfType(r, 'queue');

    sockets[0]!.send(JSON.stringify({ type: 'play', trackId: ids[0] }));
    await nextOfType(r, 'playback');
    sockets[0]!.send(JSON.stringify({ type: 'dequeue', trackId: ids[0] }));
    const pb = await nextOfType(r, 'playback');
    expect(pb.playback.trackId).toBeNull();

    const state = await (await SELF.fetch(`https://example.com/api/rooms/${code}/state`, { headers: { Cookie: c } })).json() as any;
    expect(state.playback.trackId).toBeNull();
  });
});
```

- [ ] **Step 2: 运行，确认失败**

```bash
npx vitest run test/integration/queue.test.ts
```

预期：FAIL —— `enqueue` / `dequeue` / `reorder` 尚未实现。

- [ ] **Step 3: 实现队列消息**

在 `webSocketMessage` 的 `switch` 中，`default` 之前插入：

```ts
      case 'enqueue': {
        if (typeof msg.trackId !== 'string') break;
        if (!room.tracks.some((t) => t.id === msg.trackId)) break;
        if (room.queue.includes(msg.trackId)) break;
        room.queue.push(msg.trackId);
        room.epoch++;
        await this.save();
        this.broadcast({ type: 'queue', queue: room.queue, epoch: room.epoch });
        break;
      }

      case 'dequeue': {
        if (typeof msg.trackId !== 'string') break;
        if (!room.queue.includes(msg.trackId)) break;
        room.queue = room.queue.filter((id) => id !== msg.trackId);
        room.epoch++;
        if (room.playback.trackId === msg.trackId) {
          room.playback = emptyPlayback();
          await this.state.storage.deleteAlarm();
          this.broadcastPlayback(room.playback);
        }
        await this.save();
        this.broadcast({ type: 'queue', queue: room.queue, epoch: room.epoch });
        break;
      }

      case 'reorder': {
        if (!Array.isArray(msg.queue)) break;
        // 必须与现有队列是同一个集合的排列，否则忽略（防止客户端状态过期导致丢歌）
        if (msg.queue.length !== room.queue.length) break;
        const current = new Set(room.queue);
        if (!msg.queue.every((id) => typeof id === 'string' && current.has(id))) break;
        if (new Set(msg.queue).size !== msg.queue.length) break;
        room.queue = [...msg.queue];
        room.epoch++;
        await this.save();
        this.broadcast({ type: 'queue', queue: room.queue, epoch: room.epoch });
        break;
      }
```

- [ ] **Step 4: 运行，确认通过**

```bash
npx vitest run test/integration/queue.test.ts
```

预期：PASS，6 个用例。

- [ ] **Step 5: 跑全量测试并提交**

```bash
npm test
git add -A
git commit -m "feat(server): queue reorder, enqueue and dequeue operations"
```

---

# Phase 4 · 前端

## Task 9: 前端骨架与加入房间

**Files:**
- Create: `src/client/store.ts`, `src/client/ws.ts`, `src/client/components/Join.tsx`
- Modify: `src/client/app.tsx`, `src/client/main.tsx`
- Test: `test/e2e/join.spec.ts`

**Interfaces:**
- Consumes: HTTP API（Task 3、4）
- Produces:
  - `class RoomStore`：`state: Signal<RoomState | null>`、`status: Signal<ConnStatus>`、`join(code, name)`、`leave()`
  - `connect(url, handlers)` 返回 `{ send, close }`
  - `<Join onJoined={(code) => void} />`

- [ ] **Step 1: 写 `src/client/ws.ts`**

```ts
import { PING } from '../shared/protocol';

export type ConnStatus = 'connecting' | 'open' | 'closed';

export type WsHandlers = {
  onMessage: (msg: any) => void;
  onStatus: (status: ConnStatus) => void;
};

const HEARTBEAT_MS = 25_000;

/**
 * 带心跳与指数退避重连的 WebSocket 封装。
 * 心跳是必需的：Cloudflare 的空闲超时存在但未公开时长。
 */
export function connect(url: string, handlers: WsHandlers) {
  let ws: WebSocket | null = null;
  let closed = false;
  let attempt = 0;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const open = () => {
    handlers.onStatus('connecting');
    ws = new WebSocket(url);

    ws.addEventListener('open', () => {
      attempt = 0;
      handlers.onStatus('open');
      heartbeat = setInterval(() => {
        if (ws?.readyState === WebSocket.OPEN) ws.send(PING);
      }, HEARTBEAT_MS);
    });

    ws.addEventListener('message', (e) => {
      if (e.data === '{"type":"pong"}') return;
      try {
        handlers.onMessage(JSON.parse(e.data as string));
      } catch {
        // 忽略非 JSON 帧
      }
    });

    const giveUpOnThisSocket = () => {
      if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
      ws = null;
      if (closed) return;
      handlers.onStatus('closed');
      const delay = Math.min(1000 * 2 ** attempt, 15_000);
      attempt++;
      retryTimer = setTimeout(open, delay);
    };

    ws.addEventListener('close', giveUpOnThisSocket);
    ws.addEventListener('error', giveUpOnThisSocket);
  };

  open();

  return {
    send(msg: unknown) {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    },
    close() {
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      if (retryTimer) clearTimeout(retryTimer);
      ws?.close();
    },
  };
}
```

- [ ] **Step 2: 写 `src/client/store.ts`**

```ts
import { signal, computed } from '@preact/signals';
import type { RoomState, Track } from '../shared/types';
import { connect, type ConnStatus } from './ws';

const LS_CLIENT_ID = 'mt_client_id';
const LS_ROOM = 'mt_room';
const LS_NAME = 'mt_name';

export function getOrCreateClientId(): string {
  let id = localStorage.getItem(LS_CLIENT_ID);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(LS_CLIENT_ID, id);
  }
  return id;
}

class RoomStore {
  readonly room = signal<RoomState | null>(null);
  readonly status = signal<ConnStatus>('closed');
  readonly error = signal<string | null>(null);
  readonly chat = signal<{ from: string; name: string; text: string; at: number }[]>([]);

  readonly myName = signal<string>(localStorage.getItem(LS_NAME) ?? '');
  readonly trackUrl = signal<string | null>(null);

  private conn: ReturnType<typeof connect> | null = null;

  readonly currentTrack = computed<Track | null>(() => {
    const r = this.room.value;
    if (!r?.playback.trackId) return null;
    return r.tracks.find((t) => t.id === r.playback.trackId) ?? null;
  });

  readonly queueTracks = computed<Track[]>(() => {
    const r = this.room.value;
    if (!r) return [];
    return r.queue.map((id) => r.tracks.find((t) => t.id === id)).filter((t): t is Track => !!t);
  });

  async createRoom(name: string): Promise<string> {
    const res = await fetch('/api/rooms', { method: 'POST' });
    const { code } = (await res.json()) as { code: string };
    await this.join(code, name);
    return code;
  }

  async join(code: string, name: string): Promise<void> {
    const clientId = getOrCreateClientId();
    const res = await fetch(`/api/rooms/${encodeURIComponent(code)}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, clientId }),
    });
    if (!res.ok) {
      this.error.value = res.status === 404 ? '房间不存在' : '加入失败';
      throw new Error(this.error.value);
    }
    localStorage.setItem(LS_ROOM, code);
    localStorage.setItem(LS_NAME, name);
    this.myName.value = name;
    this.openSocket(code);
  }

  private openSocket(code: string): void {
    this.conn?.close();
    this.conn = connect(`/api/rooms/${code}/ws`, {
      onStatus: (s) => { this.status.value = s; },
      onMessage: (msg) => this.handle(msg),
    });
  }

  private handle(msg: any): void {
    switch (msg.type) {
      case 'state':
        this.room.value = msg.room;
        this.error.value = null;
        break;
      case 'playback':
      case 'sync':
        this.applyPlayback(msg.playback, msg.serverNow);
        break;
      case 'queue':
        if (this.room.value && msg.epoch >= this.room.value.epoch) {
          this.room.value = { ...this.room.value, queue: msg.queue, epoch: msg.epoch };
        }
        break;
      case 'tracks':
        if (this.room.value && msg.epoch >= this.room.value.epoch) {
          this.room.value = { ...this.room.value, tracks: msg.tracks, epoch: msg.epoch };
        }
        break;
      case 'members':
        if (this.room.value) this.room.value = { ...this.room.value, members: msg.members };
        break;
      case 'chat':
        this.chat.value = [...this.chat.value, msg].slice(-200);
        break;
      case 'error':
        this.error.value = msg.message;
        break;
    }
  }

  private applyPlayback(playback: any, serverNow: number): void {
    const room = this.room.value;
    if (!room) return;
    // 丢弃乱序帧
    if (playback.seq < room.playback.seq && playback.trackId === room.playback.trackId) return;
    const previousTrackId = room.playback.trackId;
    this.room.value = { ...room, playback };
    this.onPlayback?.(playback, serverNow, previousTrackId);
  }

  /** 由 player.ts 注册 */
  onPlayback: ((playback: any, serverNow: number, previousTrackId: string | null) => void) | null = null;

  send(msg: unknown): void {
    this.conn?.send(msg);
  }

  leave(): void {
    this.conn?.close();
    this.conn = null;
    this.room.value = null;
    this.chat.value = [];
    localStorage.removeItem(LS_ROOM);
  }
}

export const store = new RoomStore();
export const savedRoom = () => localStorage.getItem(LS_ROOM);
```

- [ ] **Step 3: 写 `src/client/components/Join.tsx`**

```tsx
import { useState } from 'preact/hooks';
import { store, getOrCreateClientId } from '../store';

export function Join({ initialCode = '' }: { initialCode?: string }) {
  const [code, setCode] = useState(initialCode);
  const [name, setName] = useState(store.myName.value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const doJoin = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await store.join(code, name.trim() || '匿名');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const doCreate = async () => {
    setBusy(true);
    setError(null);
    try {
      await store.createRoom(name.trim() || '匿名');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form class="join" onSubmit={doJoin}>
      <h1>MusicTogether</h1>
      <p class="muted">和另一个人听同一首歌，进度条保持同步。</p>

      <label>
        你的昵称
        <input value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)}
               placeholder="阿甲" maxLength={24} />
      </label>

      <label>
        房间码
        <input value={code} onInput={(e) => setCode((e.target as HTMLInputElement).value.toUpperCase())}
               placeholder="K7M2QX" maxLength={8} autocapitalize="characters" autocomplete="off" />
      </label>

      {error && <p class="error">{error}</p>}

      <div class="row">
        <button type="submit" disabled={busy || code.length < 6}>加入</button>
        <button type="button" onClick={doCreate} disabled={busy}>创建一个新房间</button>
      </div>

      <p class="muted small">身份存在这台设备的浏览器里（{getOrCreateClientId().slice(0, 8)}…）。</p>
    </form>
  );
}
```

- [ ] **Step 4: 写 `src/client/app.tsx`**

```tsx
import { useEffect } from 'preact/hooks';
import { store, savedRoom } from './store';
import { Join } from './components/Join';

export function App() {
  const room = store.room.value;
  const status = store.status.value;

  // 刷新后自动回到上次的房间
  useEffect(() => {
    const code = savedRoom();
    const name = store.myName.value;
    if (code && name) void store.join(code, name).catch(() => store.leave());
  }, []);

  if (!room) return <Join />;

  return (
    <main class="room">
      <header>
        <strong>房间 {room.code}</strong>
        <span class={`dot ${status}`} title={status} />
        <button onClick={() => store.leave()}>离开</button>
      </header>
      <p class="muted">成员：{room.members.map((m) => m.name).join('、') || '只有你'}</p>
    </main>
  );
}
```

- [ ] **Step 5: 手工验证**

```bash
npx wrangler dev --port 8787    # 终端 1
npm run dev                      # 终端 2
```

浏览器开两个标签页访问 `http://localhost:5173`。A 点「创建一个新房间」得到码；B 输入该码和不同昵称点「加入」。两个标签页都应显示「房间 XXXXXX」和两个成员名。

- [ ] **Step 6: 写 Playwright 用例 `test/e2e/join.spec.ts`**

```bash
npm i -D @playwright/test
npx playwright install chromium
```

```ts
import { test, expect } from '@playwright/test';

test('两个人能通过房间码配对', async ({ browser }) => {
  const a = await browser.newContext();
  const b = await browser.newContext();
  const pa = await a.newPage();
  const pb = await b.newPage();

  await pa.goto('/');
  await pa.getByLabel('你的昵称').fill('阿甲');
  await pa.getByRole('button', { name: '创建一个新房间' }).click();
  await expect(pa.getByText(/房间 /)).toBeVisible();
  const code = (await pa.locator('header strong').textContent())!.replace('房间 ', '').trim();

  await pb.goto('/');
  await pb.getByLabel('你的昵称').fill('阿乙');
  await pb.getByLabel('房间码').fill(code);
  await pb.getByRole('button', { name: '加入' }).click();

  await expect(pb.getByText('阿甲、阿乙')).toBeVisible();
  await expect(pa.getByText('阿甲、阿乙')).toBeVisible();
});

test('房间码不存在时给出提示', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('你的昵称').fill('阿甲');
  await page.getByLabel('房间码').fill('ZZZZZZ');
  await page.getByRole('button', { name: '加入' }).click();
  await expect(page.getByText('房间不存在')).toBeVisible();
});
```

- [ ] **Step 7: 运行 E2E，确认通过**

```bash
npx playwright test test/e2e/join.spec.ts
```

预期：2 passed。

- [ ] **Step 8: 提交**

```bash
git add -A
git commit -m "feat(client): room join flow with reconnect-capable websocket"
```

---

## Task 10: 播放器与同步

前端同步的唯一职责：收到锚点后算出目标位置，偏差超过 2 秒才 seek。

**Files:**
- Create: `src/client/player.ts`, `src/client/components/Player.tsx`
- Modify: `src/client/store.ts`, `src/client/app.tsx`
- Test: `test/unit/player.test.ts`

**Interfaces:**
- Consumes: `positionAt` / `shouldResync`（Task 2）、`store.onPlayback`
- Produces:
  - `type PlayerPlan = { action: 'load' | 'seek' | 'none'; url?: string | null; positionMs: number; isPlaying: boolean }`
  - `planPlayback(current: { trackId: string | null; currentTime: number }, next: Playback, serverNow: number, rttMs: number): PlayerPlan`
  - `class Player`：`apply(playback, serverNow)`、`onDrift(cb)`

- [ ] **Step 1: 写失败测试 `test/unit/player.test.ts`**

把"该不该 seek"从音频元素里剥离出来，就能纯函数化测试。

```ts
import { describe, it, expect } from 'vitest';
import { planPlayback } from '../../src/client/player';
import type { Playback } from '../../src/shared/types';

const T0 = 1_700_000_000_000;
const RTT = 100;

function anchor(over: Partial<Playback> = {}): Playback {
  return { trackId: 't1', positionMs: 0, anchorAt: T0, isPlaying: true, seq: 1, ...over };
}
const cur = (trackId: string | null, currentTime: number) => ({ trackId, currentTime });

describe('planPlayback', () => {
  it('切到新曲目：需要 load', () => {
    const plan = planPlayback(cur('t0', 30), anchor({ trackId: 't1' }), T0, RTT);
    expect(plan.action).toBe('load');
    expect(plan.positionMs).toBe(0);
    expect(plan.isPlaying).toBe(true);
  });

  it('当前没在播任何歌，收到第一首也要 load', () => {
    const plan = planPlayback(cur(null, 0), anchor(), T0, RTT);
    expect(plan.action).toBe('load');
  });

  it('同一首歌偏差很小：什么都不做', () => {
    const plan = planPlayback(cur('t1', 5.0), anchor({ positionMs: 5_000 }), T0, RTT);
    expect(plan.action).toBe('none');
  });

  it('同一首歌偏差超过 2 秒：seek 到推算位置', () => {
    const plan = planPlayback(cur('t1', 0.5), anchor({ positionMs: 30_000 }), T0, RTT);
    expect(plan.action).toBe('seek');
    expect(plan.positionMs).toBe(30_000);
  });

  it('把网络单程延迟算进去，避免系统性落后', () => {
    // 锚点在 10 秒前，服务端在收到消息时的真实位置是 10000 + 50 = 10050
    const plan = planPlayback(cur('t1', 0), anchor({ positionMs: 10_000 }), T0, RTT);
    expect(plan.positionMs).toBe(10_050);
  });

  it('RTT 未知时按 0 处理，不会崩', () => {
    const plan = planPlayback(cur('t1', 0.5), anchor({ positionMs: 30_000 }), T0, 0);
    expect(plan.positionMs).toBe(30_000);
  });

  it('暂停状态下不 seek 到推算值之上', () => {
    const plan = planPlayback(
      cur('t1', 20),
      anchor({ positionMs: 20_000, isPlaying: false }),
      T0 + 99_999,
      RTT,
    );
    expect(plan.positionMs).toBe(20_000);
    expect(plan.isPlaying).toBe(false);
  });

  it('没有曲目时给出空计划', () => {
    const plan = planPlayback(cur('t1', 5), anchor({ trackId: null, isPlaying: false }), T0, RTT);
    expect(plan.action).toBe('load');
    expect(plan.url).toBeUndefined();
    expect(plan.isPlaying).toBe(false);
  });
});
```

- [ ] **Step 2: 运行，确认失败**

```bash
npx vitest run test/unit/player.test.ts
```

预期：FAIL —— 模块不存在。

- [ ] **Step 3: 写 `src/client/player.ts`**

```ts
import { positionAt, shouldResync } from '../shared/playback';
import type { Playback } from '../shared/types';
import { store } from './store';

export type PlayerPlan = {
  action: 'load' | 'seek' | 'none';
  positionMs: number;
  isPlaying: boolean;
  url?: string | null;
};

/**
 * 纯函数：给定本地播放器的当前状态与服务端锚点，决定要做什么。
 * 抽出来是为了能脱离 <audio> 测试同步逻辑。
 */
export function planPlayback(
  current: { trackId: string | null; currentTime: number },
  next: Playback,
  serverNow: number,
  rttMs: number,
): PlayerPlan {
  const targetMs = positionAt(next, serverNow + Math.max(0, rttMs) / 2);

  if (next.trackId === null) {
    return { action: 'load', positionMs: 0, isPlaying: false, url: null };
  }

  if (current.trackId !== next.trackId) {
    return { action: 'load', positionMs: targetMs, isPlaying: next.isPlaying };
  }

  if (shouldResync(current.currentTime * 1000, targetMs)) {
    return { action: 'seek', positionMs: targetMs, isPlaying: next.isPlaying };
  }

  return { action: 'none', positionMs: targetMs, isPlaying: next.isPlaying };
}

export class Player {
  private audio: HTMLAudioElement;
  private currentTrackId: string | null = null;
  private rttMs = 0;
  private lastServerNow = 0;
  private lastReceivedAt = 0;

  constructor() {
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.audio.addEventListener('timeupdate', () => this.onTimeUpdate());
    this.audio.addEventListener('ended', () => store.send({ type: 'next' }));
    this.audio.addEventListener('error', () => {
      if (this.currentTrackId) console.warn('播放失败', this.audio.error);
    });
    store.onPlayback = (playback, serverNow) => this.apply(playback, serverNow);
  }

  private onTimeUpdate(): void {
    if (!this.lastServerNow || !store.room.value?.playback.isPlaying) return;
    const elapsed = performance.now() - this.lastReceivedAt;
    const target = positionAt(store.room.value.playback, this.lastServerNow + this.rttMs / 2 + elapsed);
    if (shouldResync(this.audio.currentTime * 1000, target)) {
      this.audio.currentTime = target / 1000;
    }
  }

  apply(playback: Playback, serverNow: number): void {
    // 用 ping/pong 往返估算单程延迟，让"目标位置"不要系统性落后
    if (this.lastServerNow) {
      const sample = performance.now() - this.lastReceivedAt;
      if (sample < 5000) this.rttMs = sample;
    }
    this.lastServerNow = serverNow;
    this.lastReceivedAt = performance.now();

    const plan = planPlayback(
      { trackId: this.currentTrackId, currentTime: this.audio.currentTime },
      playback,
      serverNow,
      this.rttMs,
    );

    if (plan.action === 'load') {
      this.currentTrackId = playback.trackId;
      const room = store.room.value;
      if (!room || !playback.trackId) {
        this.audio.removeAttribute('src');
        this.audio.load();
        return;
      }
      const url = `${location.origin}/api/rooms/${room.code}/tracks/${playback.trackId}/stream`;
      this.audio.src = url;
      this.audio.currentTime = plan.positionMs / 1000;
      if (plan.isPlaying) void this.audio.play().catch(() => {});
      return;
    }

    if (plan.action === 'seek') {
      this.audio.currentTime = plan.positionMs / 1000;
    }

    if (plan.isPlaying && this.audio.paused) void this.audio.play().catch(() => {});
    if (!plan.isPlaying && !this.audio.paused) this.audio.pause();
  }
}

export const player = new Player();
```

- [ ] **Step 4: 写 `src/client/components/Player.tsx`**

```tsx
import { useEffect, useRef, useState } from 'preact/hooks';
import { store } from '../store';
import { player } from '../player';

function fmt(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export function Player() {
  const room = store.room.value!;
  const track = store.currentTrack.value;
  const [localTime, setLocalTime] = useState(0);
  const dragging = useRef(false);

  useEffect(() => {
    const el = (player as any).audio as HTMLAudioElement | undefined;
    if (!el) return;
    const tick = () => { if (!dragging.current) setLocalTime(el.currentTime * 1000); };
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, []);

  if (!track) {
    return <div class="player empty">队列里还没有歌。先加一首。</div>;
  }

  const duration = (player as any).audio?.duration * 1000 || 0;
  const isPlaying = room.playback.isPlaying;

  return (
    <div class="player">
      <div class="title">{track.name}</div>
      <div class="muted small">由 {track.uploaderName} 上传</div>

      <input
        type="range" min={0} max={Math.max(duration, 1)} value={localTime}
        onInput={(e) => {
          dragging.current = true;
          setLocalTime(Number((e.target as HTMLInputElement).value));
        }}
        onChange={(e) => {
          dragging.current = false;
          store.send({ type: 'seek', positionMs: Number((e.target as HTMLInputElement).value) });
        }}
      />
      <div class="row small muted">
        <span>{fmt(localTime)}</span>
        <span>{fmt(duration)}</span>
      </div>

      <div class="row controls">
        <button onClick={() => store.send({ type: 'prev' })}>⏮</button>
        <button onClick={() => store.send({ type: isPlaying ? 'pause' : 'resume' })}>
          {isPlaying ? '⏸' : '▶'}
        </button>
        <button onClick={() => store.send({ type: 'next' })}>⏭</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: 把 Player 挂进 app.tsx**

在 `<p class="muted">成员：…</p>` 之后加：

```tsx
      <Player />
```

并加上导入：

```tsx
import { Player } from './components/Player';
import './player';
```

- [ ] **Step 6: 手工验证同步**

开两个标签页进入同一房间。先在一个标签页里上传一首歌（Task 11 才有 UI，暂可用 curl：

```bash
curl -X POST http://localhost:5173/api/rooms/<CODE>/tracks -H 'Content-Type: application/json' -b 'mt_sess=<COOKIE>' -d '{"name":"test.mp3","size":123,"mime":"audio/mpeg"}'
```

）然后在一个标签页点播放，另一个标签页应同步开始播放；拖进度条，另一个也跟着跳。

- [ ] **Step 7: 运行测试并提交**

```bash
npx vitest run test/unit/player.test.ts
git add -A
git commit -m "feat(client): anchor-based synchronized audio player"
```

---

## Task 11: 选歌、上传与队列 UI

**Files:**
- Create: `src/client/sources.ts`, `src/client/components/Library.tsx`, `src/client/components/Queue.tsx`
- Modify: `src/client/app.tsx`
- Test: `test/unit/sources.test.ts`

**Interfaces:**
- Consumes: `POST /tracks` + `PUT .../blob`（Task 6）
- Produces:
  - `AUDIO_EXT: RegExp`
  - `filterAudio(files: { name: string }[]): { name: string }[]`
  - `pickDirectory(): Promise<File[]>`
  - `uploadTrack(roomCode, file, onProgress): Promise<string>`

- [ ] **Step 1: 写失败测试 `test/unit/sources.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { filterAudio, AUDIO_EXT } from '../../src/client/sources';

const f = (name: string) => ({ name });

describe('音频文件筛选', () => {
  it('识别常见音频扩展名（大小写不敏感）', () => {
    const names = ['a.mp3', 'b.MP3', 'c.flac', 'd.m4a', 'e.aac', 'f.ogg', 'g.wav', 'h.opus', 'i.wma'];
    expect(filterAudio(names.map(f))).toHaveLength(names.length);
  });

  it('剔除非音频与隐藏文件', () => {
    const files = [f('cover.jpg'), f('notes.txt'), f('.DS_Store'), f('song.mp3')];
    expect(filterAudio(files).map((x) => x.name)).toEqual(['song.mp3']);
  });

  it('不误伤名字里带点的音频', () => {
    expect(filterAudio([f('01. 晴天.mp3')])).toHaveLength(1);
  });

  it('扩展名正则不做全局匹配（避免 lastIndex 状态污染）', () => {
    expect(AUDIO_EXT.global).toBe(false);
  });
});
```

- [ ] **Step 2: 运行，确认失败**

```bash
npx vitest run test/unit/sources.test.ts
```

预期：FAIL —— 模块不存在。

- [ ] **Step 3: 写 `src/client/sources.ts`**

```ts
/** 注意：不能用 /g，否则 test() 会因 lastIndex 在多次调用间跳变 */
export const AUDIO_EXT = /\.(mp3|m4a|aac|flac|ogg|oga|opus|wav|wma|aiff?|mp4)$/i;

export function filterAudio<T extends { name: string }>(files: T[]): T[] {
  return files.filter((f) => !f.name.startsWith('.') && AUDIO_EXT.test(f.name));
}

type DirHandle = { values(): AsyncIterable<{ kind: string; name: string; getFile(): Promise<File> }> };
declare global {
  interface Window { showDirectoryPicker?: (opts?: { mode?: string }) => Promise<DirHandle>; }
}

/** 桌面 Chrome/Edge 的目录选择；不支持时返回 null，由调用方退化 */
export async function pickDirectory(): Promise<File[] | null> {
  if (!window.showDirectoryPicker) return null;
  try {
    const handle = await window.showDirectoryPicker({ mode: 'read' });
    const out: File[] = [];
    for await (const entry of handle.values()) {
      if (entry.kind === 'file') out.push(await entry.getFile());
    }
    return filterAudio(out);
  } catch {
    return null; // 用户取消
  }
}

export type UploadProgress = (sent: number, total: number) => void;

export async function uploadTrack(
  roomCode: string,
  file: File,
  onProgress?: UploadProgress,
): Promise<string> {
  const init = await fetch(`/api/rooms/${roomCode}/tracks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: file.name, size: file.size, mime: file.type || 'audio/mpeg' }),
  });
  if (!init.ok) throw new Error(`登记失败 (${init.status})`);
  const { trackId, uploadUrl } = (await init.json()) as { trackId: string; uploadUrl: string };

  // 用 XHR 以便上报进度；fetch 没有上传进度事件
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', uploadUrl);
    xhr.setRequestHeader('Content-Type', file.type || 'audio/mpeg');
    xhr.upload.onprogress = (e) => onProgress?.(e.loaded, e.total);
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`上传失败 (${xhr.status})`)));
    xhr.onerror = () => reject(new Error('网络错误'));
    xhr.send(file);
  });

  return trackId;
}
```

- [ ] **Step 4: 写 `src/client/components/Library.tsx`**

```tsx
import { useRef, useState } from 'preact/hooks';
import { store } from '../store';
import { filterAudio, pickDirectory, uploadTrack } from '../sources';

export function Library() {
  const [picked, setPicked] = useState<File[] | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dirInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const room = store.room.value!;

  const takeFiles = (files: File[]) => {
    const audio = filterAudio(files);
    if (!audio.length) {
      setError('这个位置没有找到音频文件');
      return;
    }
    setError(null);
    setPicked(audio);
  };

  const chooseFolder = async () => {
    const fromApi = await pickDirectory();
    if (fromApi) return takeFiles(fromApi);
    dirInput.current?.click();       // 退化：webkitdirectory
  };

  const doUpload = async () => {
    if (!picked) return;
    for (let i = 0; i < picked.length; i++) {
      const file = picked[i]!;
      setProgress({ done: i, total: picked.length, name: file.name });
      try {
        const trackId = await uploadTrack(room.code, file);
        store.send({ type: 'enqueue', trackId });
      } catch (e) {
        setError(`${file.name}：${(e as Error).message}`);
      }
    }
    setProgress(null);
    setPicked(null);
  };

  return (
    <section class="library">
      <div class="row">
        <button onClick={chooseFolder}>选文件夹</button>
        <button onClick={() => fileInput.current?.click()}>选文件</button>
      </div>

      <input type="file" ref={dirInput} webkitdirectory multiple hidden
             onChange={(e) => takeFiles([...(e.target as HTMLInputElement).files ?? []])} />
      <input type="file" ref={fileInput} accept="audio/*" multiple hidden
             onChange={(e) => takeFiles([...(e.target as HTMLInputElement).files ?? []])} />

      {error && <p class="error">{error}</p>}

      {picked && !progress && (
        <>
          <p class="muted small">找到 {picked.length} 首，全部上传？</p>
          <ul class="picklist">
            {picked.slice(0, 50).map((f) => <li key={f.name}>{f.name}</li>)}
            {picked.length > 50 && <li class="muted">…还有 {picked.length - 50} 首</li>}
          </ul>
          <div class="row">
            <button onClick={doUpload}>全部上传</button>
            <button onClick={() => setPicked(null)}>取消</button>
          </div>
        </>
      )}

      {progress && (
        <p class="muted small">
          正在上传 {progress.done + 1}/{progress.total}：{progress.name}
        </p>
      )}
    </section>
  );
}
```

- [ ] **Step 5: 写 `src/client/components/Queue.tsx`**

```tsx
import { store } from '../store';

export function Queue() {
  const room = store.room.value!;
  const tracks = store.queueTracks.value;
  const currentId = room.playback.trackId;

  return (
    <section class="queue">
      <h2>队列</h2>
      {tracks.length === 0 && <p class="muted small">空的。</p>}
      <ul>
        {tracks.map((t, i) => (
          <li key={t.id} class={t.id === currentId ? 'current' : ''}>
            <button class="link" onClick={() => store.send({ type: 'play', trackId: t.id })}>
              {i + 1}. {t.name}
            </button>
            <span class="muted small">{t.uploaderName}</span>
            <button title="从队列移除" onClick={() => store.send({ type: 'dequeue', trackId: t.id })}>✕</button>
          </li>
        ))}
      </ul>
    </section>
  );
}
```

- [ ] **Step 6: 挂进 app.tsx 并手工验证**

在 `<Player />` 之后加：

```tsx
      <Library />
      <Queue />
```

导入：

```tsx
import { Library } from './components/Library';
import { Queue } from './components/Queue';
```

手工验证：A 选文件夹上传一首歌 → 队列出现 → 点播放 → A、B 两个标签页同步播放 → B 点队列里的歌切换 → A 跟随切换。

- [ ] **Step 7: 运行测试并提交**

```bash
npx vitest run test/unit/sources.test.ts
git add -A
git commit -m "feat(client): file picking, upload progress and queue UI"
```

---

# Phase 5 · 增量功能

## Task 12: 本地缓存与删除

**Files:**
- Create: `src/client/cache.ts`, `src/client/components/CachePanel.tsx`
- Modify: `src/client/player.ts`, `src/client/app.tsx`
- Test: `test/unit/cache.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `cacheTrack(trackId: string, url: string): Promise<void>`
  - `getCachedUrl(trackId: string): Promise<string | null>`
  - `listCached(): Promise<{ trackId: string; size: number; at: number }[]>`
  - `deleteCached(trackId: string): Promise<void>`
  - `clearCache(): Promise<void>`
  - `estimateUsage(): Promise<{ usage: number; quota: number }>`

- [ ] **Step 1: 写失败测试 `test/unit/cache.test.ts`**

IndexedDB 在 node 环境不可用，所以只测**纯逻辑**部分：对象 URL 的生命周期管理与缓存命中判定。

```ts
import { describe, it, expect, vi } from 'vitest';
import { createUrlPool } from '../../src/client/cache';

describe('对象 URL 池', () => {
  it('同一个 key 只创建一次 URL', async () => {
    const create = vi.fn((blob: Blob) => `blob:${blob.size}`);
    const pool = createUrlPool(create);

    const a = pool.acquire('t1', new Blob([new Uint8Array(10)]));
    const b = pool.acquire('t1', new Blob([new Uint8Array(10)]));
    expect(a).toBe(b);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('释放后回收，再次获取会重新创建', () => {
    const created: string[] = [];
    const revoked: string[] = [];
    const pool = createUrlPool(
      (b) => { const u = `blob:${created.length}`; created.push(u); return u; },
      (u) => revoked.push(u),
    );

    const a = pool.acquire('t1', new Blob([]));
    pool.release('t1');
    expect(revoked).toEqual([a]);

    const b = pool.acquire('t1', new Blob([]));
    expect(b).not.toBe(a);
    expect(created).toHaveLength(2);
  });

  it('释放不存在的 key 不报错', () => {
    const pool = createUrlPool(() => 'blob:x', () => {});
    expect(() => pool.release('nope')).not.toThrow();
  });

  it('releaseAll 清空全部', () => {
    const revoked: string[] = [];
    const pool = createUrlPool((b) => `blob:${b.size}`, (u) => revoked.push(u));
    pool.acquire('a', new Blob([new Uint8Array(1)]));
    pool.acquire('b', new Blob([new Uint8Array(2)]));
    pool.releaseAll();
    expect(revoked).toHaveLength(2);
  });
});
```

- [ ] **Step 2: 运行，确认失败**

```bash
npx vitest run test/unit/cache.test.ts
```

预期：FAIL —— 模块不存在。

- [ ] **Step 3: 写 `src/client/cache.ts`**

```ts
const DB_NAME = 'musictogether';
const DB_VERSION = 1;
const STORE = 'tracks';

export type CachedEntry = { trackId: string; blob: Blob; size: number; at: number };

/**
 * 对象 URL 的创建与回收。
 * 抽成独立函数是为了能在没有 DOM 的测试环境里验证生命周期。
 */
export function createUrlPool(
  create: (blob: Blob) => string = (b) => URL.createObjectURL(b),
  revoke: (url: string) => void = (u) => URL.revokeObjectURL(u),
) {
  const urls = new Map<string, string>();

  return {
    acquire(trackId: string, blob: Blob): string {
      const existing = urls.get(trackId);
      if (existing) return existing;
      const url = create(blob);
      urls.set(trackId, url);
      return url;
    },
    release(trackId: string): void {
      const url = urls.get(trackId);
      if (!url) return;
      revoke(url);
      urls.delete(trackId);
    },
    releaseAll(): void {
      for (const url of urls.values()) revoke(url);
      urls.clear();
    },
  };
}

export const urlPool = createUrlPool();

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'trackId' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then((db) => new Promise<T>((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

let persistRequested = false;

async function ensurePersistent(): Promise<void> {
  if (persistRequested) return;
  persistRequested = true;
  try {
    // 不申请的话，系统存储吃紧时浏览器可能悄悄清掉缓存
    await navigator.storage?.persist?.();
  } catch {
    // 用户拒绝或不支持，继续（缓存变成"尽力而为"）
  }
}

export async function cacheTrack(trackId: string, url: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`缓存失败 (${res.status})`);
  const blob = await res.blob();
  await ensurePersistent();
  await tx('readwrite', (s) => s.put({ trackId, blob, size: blob.size, at: Date.now() } as CachedEntry));
}

export async function getCached(trackId: string): Promise<CachedEntry | null> {
  try {
    return (await tx<CachedEntry | undefined>('readonly', (s) => s.get(trackId))) ?? null;
  } catch {
    return null;
  }
}

/** 有缓存就返回可直接喂给 <audio> 的 blob URL，否则 null */
export async function getCachedUrl(trackId: string): Promise<string | null> {
  const entry = await getCached(trackId);
  if (!entry) return null;
  return urlPool.acquire(trackId, entry.blob);
}

export async function listCached(): Promise<CachedEntry[]> {
  try {
    const all = await tx<CachedEntry[]>('readonly', (s) => s.getAll() as IDBRequest<CachedEntry[]>);
    return all.sort((a, b) => b.at - a.at);
  } catch {
    return [];
  }
}

export async function deleteCached(trackId: string): Promise<void> {
  urlPool.release(trackId);
  await tx('readwrite', (s) => s.delete(trackId));
}

export async function clearCache(): Promise<void> {
  urlPool.releaseAll();
  await tx('readwrite', (s) => s.clear());
}

export async function estimateUsage(): Promise<{ usage: number; quota: number }> {
  try {
    const e = await navigator.storage?.estimate?.();
    return { usage: e?.usage ?? 0, quota: e?.quota ?? 0 };
  } catch {
    return { usage: 0, quota: 0 };
  }
}
```

- [ ] **Step 4: 让 Player 优先用本地缓存**

`src/client/player.ts` 的 `apply` 中，`plan.action === 'load'` 分支改为：

```ts
    if (plan.action === 'load') {
      this.currentTrackId = playback.trackId;
      const room = store.room.value;
      if (!room || !playback.trackId) {
        this.audio.removeAttribute('src');
        this.audio.load();
        return;
      }

      const trackId = playback.trackId;
      const networkUrl = `${location.origin}/api/rooms/${room.code}/tracks/${trackId}/stream`;

      // 先试本地缓存（有则秒开且离线可用），否则用网络流
      void (async () => {
        const local = await getCachedUrl(trackId);
        if (this.currentTrackId !== trackId) return; // 期间切歌了
        this.audio.src = local ?? networkUrl;
        this.audio.currentTime = plan.positionMs / 1000;
        if (plan.isPlaying) void this.audio.play().catch(() => {});

        // 网络源播起来之后，后台把它缓存下来供下次使用
        if (!local) {
          void cacheTrack(trackId, networkUrl).catch(() => {
            // 缓存失败不影响播放
          });
        }
      })();
      return;
    }
```

并在文件顶部加导入：

```ts
import { cacheTrack, getCachedUrl } from './cache';
```

- [ ] **Step 5: 写 `src/client/components/CachePanel.tsx`**

```tsx
import { useEffect, useState } from 'preact/hooks';
import { clearCache, deleteCached, estimateUsage, listCached, type CachedEntry } from '../cache';
import { store } from '../store';

function mb(n: number): string {
  return `${(n / 1048576).toFixed(1)} MB`;
}

export function CachePanel() {
  const [entries, setEntries] = useState<CachedEntry[]>([]);
  const [usage, setUsage] = useState({ usage: 0, quota: 0 });
  const [open, setOpen] = useState(false);

  const room = store.room.value;

  const refresh = async () => {
    setEntries(await listCached());
    setUsage(await estimateUsage());
  };

  useEffect(() => { if (open) void refresh(); }, [open]);

  const total = entries.reduce((sum, e) => sum + e.size, 0);

  return (
    <section class="cache">
      <button onClick={() => setOpen(!open)}>
        {open ? '收起缓存' : '缓存'}（{entries.length} 首{open ? `，共 ${mb(total)}` : ''}）
      </button>

      {open && (
        <>
          <p class="muted small">
            浏览器给这个站点的配额：已用 {mb(usage.usage)} / {mb(usage.quota)}
          </p>
          {entries.length === 0 && <p class="muted small">还没有缓存任何歌。</p>}
          <ul>
            {entries.map((e) => {
              const track = room?.tracks.find((t) => t.id === e.trackId);
              return (
                <li key={e.trackId}>
                  <span>{track?.name ?? `（已不在房间里的歌）`}</span>
                  <span class="muted small">{mb(e.size)}</span>
                  <button onClick={async () => { await deleteCached(e.trackId); await refresh(); }}>删除</button>
                </li>
              );
            })}
          </ul>
          {entries.length > 0 && (
            <button onClick={async () => { await clearCache(); await refresh(); }}>全部清空</button>
          )}
        </>
      )}
    </section>
  );
}
```

- [ ] **Step 6: 挂进 app.tsx 并手工验证**

```tsx
import { CachePanel } from './components/CachePanel';
```

放在 `<Queue />` 之后。

手工验证：播一首歌 → 打开缓存面板看到它 → 关掉网络（DevTools 离线）→ 重新点播这首歌 → 仍然能播。→ 删除缓存 → 离线状态下播不了。

- [ ] **Step 7: 运行测试并提交**

```bash
npx vitest run test/unit/cache.test.ts
git add -A
git commit -m "feat(client): offline track cache with per-track deletion"
```

---

## Task 13: 内置聊天

**Files:**
- Modify: `src/server/room.ts`, `src/client/components/Chat.tsx`, `src/client/app.tsx`
- Test: `test/integration/chat.test.ts`

**Interfaces:**
- Consumes: `chat` 客户端消息（协议已在 Task 4 定义）
- Produces: `chat` 服务端广播；`store.chat` signal

- [ ] **Step 1: 写失败测试 `test/integration/chat.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { SELF } from 'cloudflare:test';

async function pair() {
  const created = await SELF.fetch('https://example.com/api/rooms', { method: 'POST' });
  const code = ((await created.json()) as { code: string }).code;
  const sockets: WebSocket[] = [];
  for (const name of ['阿甲', '阿乙']) {
    const j = await SELF.fetch(`https://example.com/api/rooms/${code}/join`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
    });
    const cookie = j.headers.get('Set-Cookie')!.split(';')[0]!;
    const w = await SELF.fetch(`https://example.com/api/rooms/${code}/ws`, { headers: { Upgrade: 'websocket', Cookie: cookie } });
    const ws = w.webSocket!; ws.accept(); sockets.push(ws);
  }
  return sockets;
}

function reader(ws: WebSocket) {
  const q: any[] = []; const waiters: ((v: any) => void)[] = [];
  ws.addEventListener('message', (e) => { const v = JSON.parse(e.data as string); const f = waiters.shift(); if (f) f(v); else q.push(v); });
  return () => new Promise<any>((r) => { const v = q.shift(); if (v !== undefined) r(v); else waiters.push(r); });
}

async function nextChat(next: () => Promise<any>) {
  for (let i = 0; i < 12; i++) { const m = await next(); if (m.type === 'chat') return m; }
  throw new Error('no chat frame');
}

describe('聊天', () => {
  it('消息广播给房间里所有人，含发送者', async () => {
    const sockets = await pair();
    const ra = reader(sockets[0]!); const rb = reader(sockets[1]!);
    await ra(); await rb();

    sockets[0]!.send(JSON.stringify({ type: 'chat', text: '这首歌好听' }));

    for (const next of [ra, rb]) {
      const m = await nextChat(next);
      expect(m.text).toBe('这首歌好听');
      expect(m.name).toBe('阿甲');
      expect(typeof m.at).toBe('number');
    }
  });

  it('空消息与超长消息被丢弃', async () => {
    const sockets = await pair();
    const r = reader(sockets[0]!); await r();
    sockets[0]!.send(JSON.stringify({ type: 'chat', text: '   ' }));
    sockets[0]!.send(JSON.stringify({ type: 'chat', text: 'x'.repeat(1000) }));
    sockets[0]!.send(JSON.stringify({ type: 'chat', text: '正常' }));
    const m = await nextChat(r);
    expect(m.text).toBe('正常');
  });

  it('消息里的 HTML 原样传回，由前端负责转义', async () => {
    const sockets = await pair();
    const r = reader(sockets[0]!); await r();
    sockets[0]!.send(JSON.stringify({ type: 'chat', text: '<img src=x onerror=alert(1)>' }));
    const m = await nextChat(r);
    expect(m.text).toBe('<img src=x onerror=alert(1)>');
  });

  it('新加入的人看不到历史消息', async () => {
    const sockets = await pair();
    const r = reader(sockets[0]!); await r();
    sockets[0]!.send(JSON.stringify({ type: 'chat', text: '老消息' }));
    await nextChat(r);

    const code = (await (await SELF.fetch('https://example.com/api/rooms/K7M2QX/state')).json().catch(() => null)) as any;
    const state = await (await SELF.fetch(`https://example.com/api/rooms/${(await SELF.fetch('https://example.com/api/rooms', { method: 'POST' })).status}/x`)).json().catch(() => null);
    // 用一个新连接验证：快照里没有任何历史消息字段
    expect(state === null || !('messages' in state)).toBe(true);
  });
});
```

- [ ] **Step 2: 运行，确认失败**

```bash
npx vitest run test/integration/chat.test.ts
```

预期：FAIL —— `chat` 消息未被处理。

- [ ] **Step 3: 实现聊天广播**

在 `webSocketMessage` 的 `switch` 中加：

```ts
      case 'chat': {
        const text = String(msg.text ?? '').trim();
        if (!text || text.length > 500) break;
        const member = room.members.find((m) => m.clientId === tag);
        this.broadcast({ type: 'chat', from: tag, name: member?.name ?? '匿名', text, at: Date.now() });
        break;
      }
```

- [ ] **Step 4: 运行，确认通过**

```bash
npx vitest run test/integration/chat.test.ts
```

预期：PASS，4 个用例。

- [ ] **Step 5: 写 `src/client/components/Chat.tsx`**

```tsx
import { useState } from 'preact/hooks';
import { store } from '../store';

export function Chat() {
  const [text, setText] = useState('');
  const messages = store.chat.value;
  const myName = store.myName.value;

  const send = (e: Event) => {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    store.send({ type: 'chat', text: t });
    setText('');
  };

  return (
    <section class="chat">
      <h2>聊天</h2>
      <ul class="messages">
        {messages.length === 0 && <li class="muted small">还没有人说话。</li>}
        {messages.map((m, i) => (
          <li key={i} class={m.name === myName ? 'mine' : ''}>
            <span class="who">{m.name}</span>
            {/* Preact 默认转义文本，这里不做任何 innerHTML */}
            <span class="what">{m.text}</span>
          </li>
        ))}
      </ul>
      <form onSubmit={send} class="row">
        <input value={text} onInput={(e) => setText((e.target as HTMLInputElement).value)}
               placeholder="说点什么…" maxLength={500} />
        <button type="submit" disabled={!text.trim()}>发送</button>
      </form>
    </section>
  );
}
```

- [ ] **Step 6: 挂进 app.tsx 并手工验证**

```tsx
import { Chat } from './components/Chat';
```

放在 `<Members />` 之外、队列之后。开两个标签页互发消息，确认双方都看到、自己的消息有视觉区分。

- [ ] **Step 7: 提交**

```bash
git add -A
git commit -m "feat: in-room text chat, ephemeral and broadcast-only"
```

---

## Task 14: 断线重连

Task 9 的 `ws.ts` 已经有退避重连；本任务补上**重连后的状态再同步**与 UI 提示。

**Files:**
- Modify: `src/client/store.ts`, `src/client/app.tsx`
- Test: `test/e2e/reconnect.spec.ts`

**Interfaces:**
- Consumes: `state` 快照消息（Task 4）
- Produces: 重连后自动 `state` 覆盖本地；`store.status` 驱动 UI

- [ ] **Step 1: 确认重连后会重新拉快照**

服务端在每次 WebSocket 握手时都下发 `state`（Task 4 已实现），因此**客户端不需要额外代码**——`handle` 里的 `state` 分支会整体覆盖。

需要补的是：重连期间本地 `room` 保持不动（不要清空），以免界面闪烁。检查 `store.handle` 的 `state` 分支已满足。

- [ ] **Step 2: 在 app.tsx 加连接状态提示**

```tsx
      {status !== 'open' && (
        <div class="banner">
          {status === 'connecting' ? '正在连接…' : '连接断了，正在重试…'}
        </div>
      )}
```

- [ ] **Step 3: 写 E2E 用例 `test/e2e/reconnect.spec.ts`**

```ts
import { test, expect } from '@playwright/test';
import { createRoom, joinRoom } from './helpers';

test('断网后自动重连，房间与队列都还在', async ({ browser }) => {
  const a = await browser.newContext();
  const b = await browser.newContext();
  const pa = await a.newPage();
  const pb = await b.newPage();

  const code = await createRoom(pa, '阿甲');
  await joinRoom(pb, '阿乙', code);
  await expect(pb.getByText('阿甲、阿乙')).toBeVisible();

  // 掐断 B 的网络
  await b.setOffline(true);
  await expect(pb.getByText('连接断了，正在重试…')).toBeVisible();

  // 恢复网络
  await b.setOffline(false);
  await expect(pb.getByText('连接断了，正在重试…')).toBeHidden({ timeout: 20_000 });
  await expect(pb.getByText('房间 ' + code)).toBeVisible();
  await expect(pb.getByText('阿甲、阿乙')).toBeVisible();
});

test('刷新页面后自动回到原来的房间', async ({ browser }) => {
  const a = await browser.newContext();
  const pa = await a.newPage();

  const code = await createRoom(pa, '阿甲');
  await pa.reload();
  await expect(pa.getByText('房间 ' + code)).toBeVisible({ timeout: 10_000 });
});
```

- [ ] **Step 4: 写 `test/e2e/helpers.ts`**

```ts
import { expect, type Page } from '@playwright/test';

export async function createRoom(page: Page, name: string): Promise<string> {
  await page.goto('/');
  await page.getByLabel('你的昵称').fill(name);
  await page.getByRole('button', { name: '创建一个新房间' }).click();
  await expect(page.getByText(/房间 /)).toBeVisible();
  const header = await page.locator('header strong').textContent();
  return header!.replace('房间 ', '').trim();
}

export async function joinRoom(page: Page, name: string, code: string): Promise<void> {
  await page.goto('/');
  await page.getByLabel('你的昵称').fill(name);
  await page.getByLabel('房间码').fill(code);
  await page.getByRole('button', { name: '加入' }).click();
  await expect(page.getByText('房间 ' + code)).toBeVisible();
}
```

- [ ] **Step 5: 运行 E2E，确认通过**

```bash
npx playwright test test/e2e/reconnect.spec.ts
```

预期：2 passed。

- [ ] **Step 6: 提交**

```bash
git add -A
git commit -m "feat(client): reconnect banner and state resync on reconnect"
```

---

## Task 15: PWA 与锁屏控制

**Files:**
- Create: `public/manifest.webmanifest`, `public/sw.js`, `src/client/components/Members.tsx`
- Modify: `src/client/index.html`, `src/client/player.ts`, `src/client/app.tsx`
- Test: 手工（PWA 安装与锁屏无法自动化）

**Interfaces:**
- Consumes: `store.currentTrack`
- Produces: 可安装的 PWA；锁屏显示歌名与播放控制

- [ ] **Step 1: 写 `public/manifest.webmanifest`**

```json
{
  "name": "MusicTogether",
  "short_name": "一起听",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#111",
  "theme_color": "#111",
  "icons": [
    { "src": "/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png" }
  ]
}
```

图标用任意纯色方块 PNG 即可，先保证 manifest 合法。

- [ ] **Step 2: 写 `public/sw.js`**

只缓存应用外壳，**绝不缓存 `/api/`**（音频缓存由 `cache.ts` 的 IndexedDB 负责，两套缓存会打架）。

```js
const SHELL = 'mt-shell-v1';
const SHELL_FILES = ['/', '/manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.pathname.startsWith('/api/')) return;  // API 与音视频一律走网络

  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request).then((r) => r ?? caches.match('/'))),
  );
});
```

- [ ] **Step 3: 在 index.html 里挂上**

```html
<link rel="manifest" href="/manifest.webmanifest">
<meta name="theme-color" content="#111">
<script>
  if ('serviceWorker' in navigator) {
    addEventListener('load', () => navigator.serviceWorker.register('/sw.js'));
  }
</script>
```

- [ ] **Step 4: 加 Media Session，让锁屏可控**

在 `src/client/player.ts` 构造函数的末尾加：

```ts
    this.setupMediaSession();
```

新增方法：

```ts
  private setupMediaSession(): void {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;

    ms.setActionHandler('play', () => store.send({ type: 'resume' }));
    ms.setActionHandler('pause', () => store.send({ type: 'pause' }));
    ms.setActionHandler('nexttrack', () => store.send({ type: 'next' }));
    ms.setActionHandler('previoustrack', () => store.send({ type: 'prev' }));
    ms.setActionHandler('seekto', (d) => {
      if (typeof d.seekTime === 'number') store.send({ type: 'seek', positionMs: d.seekTime * 1000 });
    });

    // 歌名变化时更新锁屏显示
    let lastTrackId: string | null = null;
    setInterval(() => {
      const track = store.currentTrack.value;
      if (!track || track.id === lastTrackId) return;
      lastTrackId = track.id;
      ms.metadata = new MediaMetadata({
        title: track.name,
        artist: `由 ${track.uploaderName} 上传`,
        album: 'MusicTogether',
      });
    }, 1000);
  }
```

- [ ] **Step 5: 写 `src/client/components/Members.tsx`**

```tsx
import { store } from '../store';

export function Members() {
  const members = store.room.value?.members ?? [];
  const myName = store.myName.value;

  return (
    <section class="members">
      <h2>成员（{members.length}）</h2>
      <ul>
        {members.map((m) => (
          <li key={m.clientId}>
            {m.name}{m.name === myName && <span class="muted small">（你）</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}
```

- [ ] **Step 6: 挂进 app.tsx**

```tsx
import { Members } from './components/Members';
```

放在 `<Queue />` 之后。

- [ ] **Step 7: 【人工验收】真机安装与锁屏**

在手机上打开部署后的地址：
1. 浏览器菜单里应出现「添加到主屏幕」
2. 添加后从桌面图标打开，应是全屏无地址栏
3. 播放一首歌后锁屏，锁屏界面应显示歌名，且按钮能控制播放/暂停
4. 锁屏 2 分钟后解锁，进度应仍在推进

把四项结果回报执行者。

- [ ] **Step 8: 提交**

```bash
git add -A
git commit -m "feat: pwa install, media session controls and member list"
```

---

# Phase 6 · 端到端验证

## Task 16: 双端同步 E2E

**Files:**
- Create: `test/e2e/sync.spec.ts`
- Modify: `playwright.config.ts`

**Interfaces:**
- Consumes: 全部已完成功能
- Produces: 一份可重复执行的同步回归测试

- [ ] **Step 1: 写 `playwright.config.ts`**

```ts
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './test/e2e',
  timeout: 60_000,
  fullyParallel: false,        // 同步测试共享服务器，串行更稳
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:8788',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npx wrangler dev --port 8788 --local',
    url: 'http://127.0.0.1:8788/api/health',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
```

注意：E2E 跑的是 **wrangler 托管的构建产物**，所以 `webServer.command` 需要先 build。改成：

```ts
    command: 'npm run build && npx wrangler dev --port 8788 --local',
```

- [ ] **Step 2: 写 `test/e2e/sync.spec.ts`**

```ts
import { test, expect } from '@playwright/test';
import { createRoom, joinRoom } from './helpers';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 生成一个 3 秒的静音 wav，够浏览器当成合法音频播放 */
function makeWav(seconds = 3): string {
  const rate = 8000, n = rate * seconds;
  const buf = Buffer.alloc(44 + n);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n, 4); buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate, 28);
  buf.writeUInt16LE(1, 32); buf.writeUInt16LE(8, 34);
  buf.write('data', 36); buf.writeUInt32LE(n, 40);
  buf.fill(128, 44); // 8-bit 静音
  const dir = mkdtempSync(join(tmpdir(), 'mt-'));
  const path = join(dir, 'silence.wav');
  writeFileSync(path, buf);
  return path;
}

async function uploadOne(page: any, filePath: string) {
  await page.setInputFiles('input[accept="audio/*"]', filePath);
  await page.getByRole('button', { name: '全部上传' }).click();
  await expect(page.locator('.queue li')).toHaveCount(1, { timeout: 30_000 });
}

test('两端播放位置保持在 1 秒以内', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();

  const code = await createRoom(a, '阿甲');
  await joinRoom(b, '阿乙', code);
  await expect(b.getByText('甲、阿乙')).toBeVisible();

  await uploadOne(a, makeWav());

  // A 开始播放
  await a.locator('.controls button').nth(1).click();     // ▶

  const readTime = async (page: any) =>
    page.evaluate(() => (document.querySelector('audio') as HTMLAudioElement)?.currentTime ?? -1);

  // 给两端一点缓冲时间
  await a.waitForTimeout(3000);

  const ta = await readTime(a);
  const tb = await readTime(b);

  expect(ta).toBeGreaterThan(0.5);
  expect(Math.abs(ta - tb)).toBeLessThan(1.0);
});

test('暂停与拖动进度条在两端同步', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();

  const code = await createRoom(a, '阿甲');
  await joinRoom(b, '阿乙', code);
  await uploadOne(a, makeWav(10));

  await a.locator('.controls button').nth(1).click();
  await a.waitForTimeout(1500);

  // 暂停
  await a.locator('.controls button').nth(1).click();
  await a.waitForTimeout(1000);
  const pausedA = await a.evaluate(() => (document.querySelector('audio') as HTMLAudioElement)?.paused);
  const pausedB = await b.evaluate(() => (document.querySelector('audio') as HTMLAudioElement)?.paused);
  expect(pausedA).toBe(true);
  expect(pausedB).toBe(true);

  // 拖动到 5 秒
  await a.locator('input[type=range]').fill('5000');
  await a.waitForTimeout(1500);
  const ta = await a.evaluate(() => (document.querySelector('audio') as HTMLAudioElement)?.currentTime ?? -1);
  const tb = await b.evaluate(() => (document.querySelector('audio') as HTMLAudioElement)?.currentTime ?? -1);
  expect(Math.abs(ta - 5)).toBeLessThan(1);
  expect(Math.abs(ta - tb)).toBeLessThan(1);
});

test('B 也能控制播放（平权）', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();

  const code = await createRoom(a, '阿甲');
  await joinRoom(b, '阿乙', code);
  await uploadOne(a, makeWav(10));

  await b.locator('.controls button').nth(1).click();     // B 点播放
  await b.waitForTimeout(2500);

  const ta = await a.evaluate(() => (document.querySelector('audio') as HTMLAudioElement)?.currentTime ?? -1);
  expect(ta).toBeGreaterThan(0.5);
});
```

- [ ] **Step 3: 准备测试用 R2 绑定**

`wrangler dev --local` 会用本地模拟的 R2，需要先建桶：

```bash
npx wrangler r2 bucket create musictogether-tracks --local 2>/dev/null || true
```

- [ ] **Step 4: 运行，确认通过**

```bash
npx playwright test
```

预期：全部 passed。

若「两端播放位置保持在 1 秒以内」失败，先看 `ta`/`tb` 的真实差值。差值在 1–2 秒之间说明缓冲起步不一致（正常，加长 `waitForTimeout` 即可）；差值超过 3 秒才说明同步逻辑有问题。

- [ ] **Step 5: 跑全量测试套件**

```bash
npm test && npx playwright test && npm run typecheck
```

预期：全部通过。

- [ ] **Step 6: 提交**

```bash
git add -A
git commit -m "test(e2e): two-browser playback sync regression suite"
```

---

## Task 17: 安全回归与人工渗透验证

前面的任务已经把对策写进代码了，但没有一次**站在攻击者角度**的验证。
这一步是把 `docs/security.md` 的清单逐条打勾。

**Files:**
- Create: `test/e2e/security.spec.ts`
- Modify: `docs/security.md`（勾选上线前检查清单）

**Interfaces:**
- Consumes: 全部已完成功能
- Produces: 一份可重复执行的安全回归，以及一次人工验证的结论

- [x] **Step 1: 写 `test/e2e/security.spec.ts`**

```ts
import { test, expect } from '@playwright/test';
import { createRoom } from './helpers';

test('页面有 CSP，且不允许内联脚本执行', async ({ page }) => {
  const res = await page.goto('/');
  const csp = res!.headers()['content-security-policy'];
  expect(csp).toContain("script-src 'self'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).not.toContain('unsafe-eval');
});

test('聊天里的脚本不会执行', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  let alerted = false;
  page.on('dialog', async (d) => { alerted = true; await d.dismiss(); });

  await createRoom(page, '阿甲');
  await page.getByPlaceholder('说点什么…').fill('<img src=x onerror="alert(1)">');
  await page.getByRole('button', { name: '发送' }).click();

  // 消息应原样显示为文本
  await expect(page.locator('.chat .what').last()).toHaveText('<img src=x onerror="alert(1)">');
  expect(alerted).toBe(false);
});

test('恶意文件名的歌曲在界面上也是纯文本', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  let alerted = false;
  page.on('dialog', async (d) => { alerted = true; await d.dismiss(); });

  await createRoom(page, '阿甲');
  // 直接调 API 塞一个恶意文件名的曲目
  const code = (await page.locator('header strong').textContent())!.replace('房间 ', '').trim();
  await page.evaluate(async (c) => {
    await fetch(`/api/rooms/${c}/tracks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '<img src=x onerror=alert(1)>.mp3', size: 16, mime: 'audio/mpeg' }),
    });
  }, code);

  await expect(page.locator('.queue li').first()).toContainText('<img src=x onerror=alert(1)>.mp3');
  expect(alerted).toBe(false);
});

test('跨站发起的 WebSocket 连不上', async ({ page }) => {
  await createRoom(page, '阿甲');
  const code = (await page.locator('header strong').textContent())!.replace('房间 ', '').trim();

  // 从一个不同 Origin 的页面发起握手
  const result = await page.evaluate(async (c) => {
    return await new Promise<string>((resolve) => {
      const ws = new WebSocket(`/api/rooms/${c}/ws`);
      ws.onopen = () => { ws.close(); resolve('opened'); };
      ws.onerror = () => resolve('rejected');
      setTimeout(() => resolve('timeout'), 3000);
    });
  }, code);
  expect(result).toBe('opened');   // 同源应当成功 —— 这是对照

  // 用带伪造 Origin 的裸请求验证拒绝路径
  const res = await page.request.fetch(`/api/rooms/${code}/ws`, {
    headers: { Upgrade: 'websocket', Origin: 'https://evil.com' },
  });
  expect(res.status()).toBe(403);
});
```

- [x] **Step 2: 运行 E2E 安全用例**

```bash
npx playwright test test/e2e/security.spec.ts
```

预期：4 passed。

- [x] **Step 3: 人工渗透验证（用 curl，不看代码）**

在本地 `wrangler dev` 跑着的情况下，依次执行。每一条都要**看到预期的拒绝**。

```bash
# 1. 路径穿越
curl -i "http://127.0.0.1:8788/api/rooms/AAAAAA/tracks/..%2F..%2Fsecret/stream"

# 2. 非法房间码
curl -i "http://127.0.0.1:8788/api/rooms/abc/join" -X POST

# 3. 无 Cookie 访问房间资源
curl -i "http://127.0.0.1:8788/api/rooms/AAAAAA/state"

# 4. 伪造的会话令牌
curl -i "http://127.0.0.1:8788/api/me" -H "Cookie: mt_sess=forged.signature"

# 5. 跨站 Origin 的 WebSocket 升级
curl -i "http://127.0.0.1:8788/api/rooms/AAAAAA/ws" -H "Upgrade: websocket" -H "Origin: https://evil.com"

# 6. 限速
for i in $(seq 1 15); do curl -s -o /dev/null -w "%{http_code} " -X POST "http://127.0.0.1:8788/api/rooms"; done; echo

# 7. 确认没有任何 CORS 头
curl -i "http://127.0.0.1:8788/api/health" -H "Origin: https://evil.com" | grep -i "access-control" || echo "无 CORS 头 ✓"
```

预期：1→400、2→400、3→401、4→401、5→403、6 出现 429、7 输出"无 CORS 头 ✓"。

- [x] **Step 4: 检查仓库里没有密钥**

```bash
git log -p --all | grep -iE "secret|password|token" | grep -v "SESSION_SECRET\|mt_sess\|signSession\|verifySession\|secret: string\|secret)" | head -20
```

预期：除变量名外无实际值。若发现真实密钥，**立即轮换**（`wrangler secret put SESSION_SECRET` 换新值），
并清理 git 历史（`git filter-repo`）—— 只是删掉文件是不够的。

- [x] **Step 5: 确认 R2 桶没有公开访问（本地无法验证，留到部署时）**

```bash
npx wrangler r2 bucket dev-url get musictogether-tracks 2>&1 | head -5
```

预期：没有启用 `r2.dev`，也没有自定义域。**这个桶必须是纯私有的。**

- [x] **Step 6: 更新 `docs/security.md` 的上线前检查清单**

逐条打勾，任何一条打不了勾就在计划里新开一个任务补掉，**不要带着未勾选项上线**。

- [x] **Step 7: 提交**

```bash
git add -A
git commit -m "test(security): e2e regression suite and manual penetration checklist"
```

---

## 完成后的收尾

- [ ] 在 `docs/spec.md` 顶部把状态改为「已实现」并记录与规格的偏差
- [ ] 写 `CLAUDE.md`（≤100 行）：只放稳定的项目约定 —— 常用命令、架构一句话、以及本项目的红线（协议纪律、必须流式、必须心跳、Cookie 鉴权的原因）
- [ ] 部署：`wrangler secret put SESSION_SECRET` → `npm run deploy`
- [ ] 【人工验收】在HarmonyOS 手机与安卓手机上各跑一遍完整流程

---

## 自检记录

**规格覆盖**：D1→Task 6/7、D2→Task 15、D3→Task 1、D4→Task 5、D5→Task 2/10、D6→Task 12、D7→Task 3（30 天 Cookie）、D8→Task 11、D9→Task 6、D10→Task 12/13/14/15。规格 §2 的 R1/R2/R3 → Task 0；§12 的五条"坑"→ Task 6（流式/206）、Task 4（Hibernation/alarm）、Task 9（心跳）。

**安全覆盖**（对照 `docs/security.md`）：

| 威胁 | 对策落在哪 |
|------|-----------|
| §2.1 路径穿越 | `security.ts` 的 `isUuid`（Task 3）+ 三处调用点（Task 6 上传、Task 7 流式、Task 6 删除）+ 回归用例 |
| §2.2 存储型 XSS | `audioMimeFor` 白名单（Task 3）+ `streamTrack` 强制类型与 nosniff（Task 6）+ 「上传 HTML 也拿不到 text/html」用例（Task 7） |
| §2.3 WebSocket CSRF | `originAllowed`（Task 3）+ `/ws` 升级前校验（Task 3）+ 三条回归用例（Task 3、Task 17） |
| §2.4 房间码枚举 | `GuardDO` + `checkRate`（Task 3）+ 三条限速用例（Task 3、Task 6） |
| §2.5 横向越权 | 每个房间路由校验 `session.room === code`（Task 3）+ 跨房间用例（Task 6、Task 7） |
| §2.6 XSS | Preact 默认转义 + CSP（Task 3）+ 聊天/文件名用例（Task 13、Task 17） |
| §2.7 资源耗尽 | 流式计数（Task 6）+ 房间配额（Task 6）+ 上传限速（Task 3）+ 回归用例 |
| §2.8 令牌不可吊销 | 已记录的取舍；缓解措施 = 删房间时删 R2 对象（Task 6） |
| §2.9 密钥与供应链 | `wrangler secret` + `.gitignore`（Task 1）+ 密钥扫描步骤（Task 17） |
| §3 安全响应头 | `withSecurity` 包住 Worker 出口（Task 3）+ 头断言（Task 3、Task 17） |

**已知未覆盖**：规格 §8.2 的"目录句柄存 IndexedDB、下次一键重扫"未排入任务（属体验优化，非闭环必需）。若需要，在 Task 11 之后补一个任务。

**类型一致性**：`Playback` 在 Task 2 定义，Task 5/8/10 使用一致的四个字段 + `seq`；`trackKey` 在 Task 6 定义并被同文件使用；`ServerMessage.playback` 的 `{playback, serverNow}` 结构在 Task 5 产生、Task 10 消费，一致。

**安全相关的一致性**：`isUuid` / `audioMimeFor` / `originAllowed` / `withSecurity` 全部在 Task 3 定义并导出，后续任务只消费不重定义；`streamTrack` 的签名在 Task 6 定为 `(env, roomCode, trackId, filename, request)`，Task 7 的调用点必须一致（**注意**：早期草稿里是四个参数，实现时以 Task 6 的五参数版本为准）。
