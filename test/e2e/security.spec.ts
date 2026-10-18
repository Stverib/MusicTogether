import { test, expect, type Page } from '@playwright/test';
import { createRoom, joinRoom, makeWav, uploadOne } from './helpers';

/** 记下页面弹出的任何对话框 —— 有就说明注入成功了 */
function watchDialogs(page: Page): { readonly fired: () => boolean } {
  let fired = false;
  page.on('dialog', (d) => {
    fired = true;
    void d.dismiss();
  });
  return { fired: () => fired };
}

const codeOf = async (page: Page): Promise<string> =>
  (await page.locator('header strong').textContent())!.replace('房间 ', '').trim();

test('静态外壳带安全响应头，且 CSP 与 API 的完全一致', async ({ page, request }) => {
  const res = await page.goto('/');
  const headers = res!.headers();

  expect(headers['content-security-policy']).toContain("script-src 'self'");
  expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
  expect(headers['content-security-policy']).toContain("object-src 'none'");
  expect(headers['content-security-policy']).not.toContain('unsafe-eval');
  // script-src 里不能有 unsafe-inline：有的话内联注入就能跑，CSP 等于白设
  const scriptSrc = headers['content-security-policy']!
    .split(';')
    .map((d) => d.trim())
    .find((d) => d.startsWith('script-src'))!;
  expect(scriptSrc).not.toContain('unsafe-inline');
  expect(headers['x-content-type-options']).toBe('nosniff');
  // 房间码在 URL 路径里，任何外链都不能把它放进 Referer
  expect(headers['referrer-policy']).toBe('no-referrer');
  expect(headers['x-frame-options']).toBe('DENY');

  // 外壳的策略来自 public/_headers，API 的策略来自 src/server/security.ts。
  // 两份是手写的，这条断言保证它们不会各自漂移。
  const api = await request.get('/api/health');
  expect(api.headers()['content-security-policy']).toBe(headers['content-security-policy']);
});

test('没有内联脚本 —— 有的话会被上面的 CSP 直接挡掉', async ({ page }) => {
  await page.goto('/');
  const inline = await page.evaluate(
    () => document.querySelectorAll('script:not([src])').length,
  );
  expect(inline).toBe(0);
});

test('Service Worker 能注册成功（CSP 没把它挡掉）', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(
    async () => (await navigator.serviceWorker.getRegistration()) !== undefined,
    undefined,
    { timeout: 15_000 },
  );
});

test('聊天里的脚本不会执行', async ({ page }) => {
  const dialogs = watchDialogs(page);
  await createRoom(page, '阿甲');

  const payload = '<img src=x onerror="alert(1)">';
  await page.getByPlaceholder('说点什么…').fill(payload);
  await page.getByRole('button', { name: '发送' }).click();

  // 原样显示成文本，而不是被解析成元素
  const last = page.locator('.chat .messages li').last();
  await expect(last.locator('.what')).toHaveText(payload);
  await expect(last.locator('img')).toHaveCount(0);
  expect(dialogs.fired()).toBe(false);
});

test('恶意文件名的歌曲在界面上也是纯文本', async ({ page }) => {
  const dialogs = watchDialogs(page);
  await createRoom(page, '阿甲');
  const code = await codeOf(page);

  const payload = '<img src=x onerror=alert(1)>.mp3';
  const res = await page.request.post(`/api/rooms/${code}/tracks`, {
    data: { name: payload, size: 16, mime: 'audio/mpeg' },
  });
  expect(res.ok()).toBe(true);
  const { trackId } = (await res.json()) as { trackId: string };

  // 字节要真的上传，曲目才会进队列（队列里的每一首都必须能播）
  const put = await page.request.put(`/api/rooms/${code}/tracks/${trackId}/blob`, {
    data: 'x'.repeat(16),
  });
  expect(put.ok()).toBe(true);

  const item = page.locator('.queue li').first();
  await expect(item).toContainText(payload);
  await expect(item.locator('img')).toHaveCount(0);
  expect(dialogs.fired()).toBe(false);
});

test('上传 HTML 文件后访问流地址，拿到的不是 text/html', async ({ page }) => {
  await createRoom(page, '阿甲');
  const code = await codeOf(page);

  // 文件名后缀决定出站 Content-Type，用户声明的 MIME 只进元数据
  const body = '<script>alert(1)</script>';
  const res = await page.request.post(`/api/rooms/${code}/tracks`, {
    data: { name: 'evil.html', size: body.length, mime: 'text/html' },
  });
  const { trackId } = (await res.json()) as { trackId: string };

  const put = await page.request.put(`/api/rooms/${code}/tracks/${trackId}/blob`, {
    data: body,
    headers: { 'Content-Type': 'text/html' },
  });
  expect(put.ok()).toBe(true);

  const stream = await page.request.get(`/api/rooms/${code}/tracks/${trackId}/stream`);
  expect(stream.headers()['content-type']).toBe('application/octet-stream');
  expect(stream.headers()['content-type']).not.toContain('html');
  expect(stream.headers()['x-content-type-options']).toBe('nosniff');
});

test('路径穿越与非法 trackId 被挡住', async ({ page }) => {
  await createRoom(page, '阿甲');
  const code = await codeOf(page);

  const traversal = await page.request.get(
    `/api/rooms/${code}/tracks/..%2F..%2Fsecret/stream`,
  );
  expect([400, 404]).toContain(traversal.status());

  const notUuid = await page.request.get(`/api/rooms/${code}/tracks/not-a-uuid/stream`);
  expect([400, 404]).toContain(notUuid.status());
});

test('没有 Cookie 就进不了房间', async ({ page }) => {
  await createRoom(page, '阿甲');
  const code = await codeOf(page);

  // 换一个干净的上下文，不带任何 Cookie
  const anon = await page.context().browser()!.newContext();
  const res = await anon.request.get(`/api/rooms/${code}/state`);
  expect(res.status()).toBe(401);

  const forged = await anon.request.get(`/api/rooms/${code}/state`, {
    headers: { Cookie: 'mt_sess=forged.signature' },
  });
  expect(forged.status()).toBe(401);

  await anon.close();
});

test('拿着 A 房间的会话进不了 B 房间', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();

  const roomA = await createRoom(a, '阿甲');
  const roomB = await createRoom(b, '阿乙');

  // a 的会话是 roomA 的，拿去访问 roomB 必须被拒（横向越权）
  const res = await a.request.get(`/api/rooms/${roomB}/state`);
  expect(res.status()).toBe(401);

  // 自己房间是通的 —— 对照组
  expect((await a.request.get(`/api/rooms/${roomA}/state`)).status()).toBe(200);

  await ctxA.close();
  await ctxB.close();
});

test('跨站 Origin 的 WebSocket 升级被拒，同源的能连上', async ({ page }) => {
  await createRoom(page, '阿甲');
  const code = await codeOf(page);

  // 对照：同源握手应当成功
  const sameOrigin = await page.evaluate(
    (c) =>
      new Promise<string>((resolve) => {
        const ws = new WebSocket(`/api/rooms/${c}/ws`);
        ws.onopen = () => {
          ws.close();
          resolve('opened');
        };
        ws.onerror = () => resolve('rejected');
        setTimeout(() => resolve('timeout'), 5000);
      }),
    code,
  );
  expect(sameOrigin).toBe('opened');

  // 攻击者页面：Origin 不是自己，必须 403。
  // 这条用裸请求发，因为浏览器里造不出伪造的 Origin。
  const evil = await page.request.fetch(`/api/rooms/${code}/ws`, {
    headers: { Upgrade: 'websocket', Connection: 'Upgrade', Origin: 'https://evil.com' },
  });
  expect(evil.status()).toBe(403);

  // 干脆不带 Origin 也一样拒
  const bare = await page.request.fetch(`/api/rooms/${code}/ws`, {
    headers: { Upgrade: 'websocket', Connection: 'Upgrade' },
  });
  expect(bare.status()).toBe(403);
});

test('房间码枚举：不存在的房间一律 404，且响应里没有 CORS 头', async ({ page }) => {
  const res = await page.request.post('/api/rooms/ZZZZZZ/join', {
    data: { name: '阿甲' },
    headers: { Origin: 'https://evil.com' },
  });
  expect(res.status()).toBe(404);

  for (const [name, value] of Object.entries(res.headers())) {
    expect(name.toLowerCase()).not.toContain('access-control');
    expect(value).not.toContain('evil.com');
  }
});

test('只有上传者能删云端文件，别人只能移出队列', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();

  const code = await createRoom(a, '阿甲');
  await joinRoom(b, '阿乙', code);
  await uploadOne(a, makeWav({ seconds: 3, name: 'mine.wav' }));
  await expect(b.locator('.queue li')).toHaveCount(1, { timeout: 15_000 });

  const id = await b.evaluate(async (c) => {
    const res = await fetch(`/api/rooms/${c}/state`);
    const state = (await res.json()) as { tracks: { id: string }[] };
    return state.tracks[0]!.id;
  }, code);

  // 阿乙不是上传者 —— 删云端文件必须 403
  const denied = await b.request.delete(`/api/rooms/${code}/tracks/${id}`);
  expect(denied.status()).toBe(403);

  // 上传者本人可以
  expect((await a.request.delete(`/api/rooms/${code}/tracks/${id}`)).status()).toBe(200);

  await ctxA.close();
  await ctxB.close();
});
