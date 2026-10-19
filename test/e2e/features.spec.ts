import { test, expect, type Page } from '@playwright/test';
import { audioState, createRoom, joinRoom, makeWav, uploadOne, waitForPlaying } from './helpers';

/** 直接读 IndexedDB，确认缓存真的落盘了，而不只是界面上写着有 */
function cachedCount(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const req = indexedDB.open('musictogether', 1);
        req.onerror = () => resolve(-1);
        req.onsuccess = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('tracks')) return resolve(0);
          const r = db.transaction('tracks', 'readonly').objectStore('tracks').count();
          r.onsuccess = () => resolve(r.result);
          r.onerror = () => resolve(-1);
        };
      }),
  );
}

async function twoSides(browser: import('@playwright/test').Browser) {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  return { ctxA, ctxB, a: await ctxA.newPage(), b: await ctxB.newPage() };
}

test('没有 crypto.randomUUID 时也要能启动', async ({ page }) => {
  // 非安全上下文里这个 API 根本不存在。安全上下文不只是 HTTPS：
  // http://localhost 算，http://192.168.1.5 这种局域网地址不算 ——
  // 而身份正好是在渲染时就要用到的，缺了它整页白屏。
  await page.addInitScript(() => {
    Object.defineProperty(Crypto.prototype, 'randomUUID', {
      value: undefined,
      configurable: true,
    });
  });

  await page.goto('/');
  await expect(page.getByRole('button', { name: '创建一个新房间' })).toBeVisible();

  // 不只是能显示 —— 真的能建房（这一步才会去生成 clientId）
  await page.getByLabel('你的昵称').fill('阿甲');
  await page.getByRole('button', { name: '创建一个新房间' }).click();
  await expect(page.locator('header strong')).toContainText('房间 ', { timeout: 15_000 });
});

/**
 * 伪造"页面被切到后台"。
 *
 * Playwright 没有真的把页面藏起来的办法 —— `document.hidden` 是只读的，
 * 页面也不会真的失焦。但实现就挂在 `visibilitychange` 上，所以改写这两个
 * 属性再派发事件，测的正是那条接线本身。
 */
async function setVisible(page: Page, visible: boolean): Promise<void> {
  await page.evaluate((v) => {
    Object.defineProperty(document, 'hidden', { value: !v, configurable: true });
    Object.defineProperty(document, 'visibilityState', {
      value: v ? 'visible' : 'hidden',
      configurable: true,
    });
    document.dispatchEvent(new Event('visibilitychange'));
  }, visible);
}

test('页面切到后台就算离开，另一端立刻看到灰点', async ({ browser }) => {
  const { ctxA, ctxB, a, b } = await twoSides(browser);
  const code = await createRoom(a, '阿甲');
  await joinRoom(b, '阿乙', code);

  const yiAtA = a.locator('.members li', { hasText: '阿乙' });
  await expect(yiAtA.locator('.presence.on')).toHaveCount(1);

  // 阿乙把浏览器切走 —— 连接没断，只是人不在看
  await setVisible(b, false);
  await expect(yiAtA.locator('.presence.off')).toHaveCount(1);
  await expect(yiAtA).toContainText('已离开');

  // 切回来就又是在线
  await setVisible(b, true);
  await expect(yiAtA.locator('.presence.on')).toHaveCount(1);
  await expect(yiAtA).toContainText('在线');

  await ctxA.close();
  await ctxB.close();
});

test('绿点在名字右边，且绿点确实偏绿', async ({ browser }) => {
  const { ctxA, ctxB, a, b } = await twoSides(browser);
  const code = await createRoom(a, '阿甲');
  await joinRoom(b, '阿乙', code);

  const yiAtA = a.locator('.members li', { hasText: '阿乙' });
  await expect(yiAtA.locator('.presence.on')).toHaveCount(1);

  const geo = await yiAtA.evaluate((li) => {
    const name = li.querySelector('.name')!.getBoundingClientRect();
    const dot = li.querySelector('.presence')!.getBoundingClientRect();
    const rgb = getComputedStyle(li.querySelector('.presence')!).backgroundColor;
    const [r, g, bl] = rgb.match(/\d+/g)!.map(Number) as [number, number, number];
    return { nameRight: name.right, dotLeft: dot.left, r, g, b: bl };
  });

  // 点在名字右边，不是左边
  expect(geo.dotLeft).toBeGreaterThanOrEqual(geo.nameRight - 1);
  // 绿：绿通道明显高过红和蓝。断言语义而不是写死色号 —— 色号会随配色调整变
  expect(geo.g).toBeGreaterThan(geo.r);
  expect(geo.g).toBeGreaterThan(geo.b);

  await setVisible(b, false);
  await expect(yiAtA.locator('.presence.off')).toHaveCount(1);

  const away = await yiAtA.evaluate((li) => {
    const rgb = getComputedStyle(li.querySelector('.presence')!).backgroundColor;
    const [r, g, bl] = rgb.match(/\d+/g)!.map(Number) as [number, number, number];
    return { r, g, b: bl };
  });
  // 暖灰（这套配色里没有纯灰，--ink-3 的通道差就是 44）。判据是"没有哪个通道
  // 明显占优" —— 绿点那边的差是 79，两者不会混
  expect(Math.max(away.r, away.g, away.b) - Math.min(away.r, away.g, away.b)).toBeLessThan(60);

  await ctxA.close();
  await ctxB.close();
});

test('聊天消息两端都出现，发送后输入框清空', async ({ browser }) => {
  const { ctxA, ctxB, a, b } = await twoSides(browser);
  const code = await createRoom(a, '阿甲');
  await joinRoom(b, '阿乙', code);

  await a.getByPlaceholder('说点什么…').fill('晚上听什么');
  await a.getByRole('button', { name: '发送' }).click();

  for (const page of [a, b]) {
    const last = page.locator('.chat .messages li').last();
    await expect(last).toContainText('晚上听什么');
    await expect(last.locator('.who')).toHaveText('阿甲');
  }
  await expect(a.getByPlaceholder('说点什么…')).toHaveValue('');

  // 反向也通（平权）
  await b.getByPlaceholder('说点什么…').fill('随便');
  await b.getByRole('button', { name: '发送' }).click();
  await expect(a.locator('.chat .messages li').last()).toContainText('随便');

  await ctxA.close();
  await ctxB.close();
});

test('断线后自动重连，恢复后两端位置重新对齐', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();

  // 把每个 WebSocket 实例挂到 window 上，测试才能从外面把它掐断。
  // 真实的断线（服务器重启、切网络）在测试里没有别的办法复现 ——
  // CDP 的 setOffline 只挡新请求，已经建好的 WebSocket 照样活着。
  await ctxB.addInitScript(() => {
    const Orig = window.WebSocket;
    const sockets: WebSocket[] = [];
    (window as unknown as { __sockets: WebSocket[] }).__sockets = sockets;
    window.WebSocket = class extends Orig {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        sockets.push(this);
      }
    } as unknown as typeof WebSocket;
  });

  const a = await ctxA.newPage();
  const b = await ctxB.newPage();

  const code = await createRoom(a, '阿甲');
  await joinRoom(b, '阿乙', code);

  // 用 60 秒的歌：重连与重新对齐要花几秒，短歌会先播完
  await uploadOne(a, makeWav({ seconds: 60, name: 'reconnect-60s.wav' }));
  await a.locator('.player .primary').click();
  await waitForPlaying(a);
  await waitForPlaying(b);

  // 连续掐 3 秒。掐一次的话，可能在两次断言轮询之间就自己连回去了，
  // 观察不到"断开"这个状态。
  await b.evaluate(() => {
    const w = window as unknown as { __sockets: WebSocket[] };
    const timer = setInterval(() => {
      for (const ws of w.__sockets) ws.close();
    }, 300);
    setTimeout(() => clearInterval(timer), 3000);
  });

  await expect(b.locator('.banner')).toBeVisible({ timeout: 20_000 });
  await expect(b.locator('.dot.open')).toHaveCount(0);

  // 放手之后应当靠指数退避自己连回来
  await expect(b.locator('.banner')).toBeHidden({ timeout: 30_000 });
  await expect(b.locator('.dot.open')).toBeVisible({ timeout: 15_000 });

  // 关键：重连之后位置要重新对上，而不是各自漂着
  await expect
    .poll(
      async () => {
        const sa = await audioState(a);
        const sb = await audioState(b);
        return Math.abs(sa.currentTime - sb.currentTime);
      },
      { timeout: 30_000 },
    )
    .toBeLessThan(1.5);

  await ctxA.close();
  await ctxB.close();
});

test('播放后自动缓存到本地，重载走本地副本，删掉后回到网络流', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  await createRoom(page, '阿甲');
  await uploadOne(page, makeWav({ seconds: 60, name: 'cache-60s.wav' }));
  await page.locator('.player .primary').click();
  await waitForPlaying(page);

  // 缓存是后台做的，等它真的写进 IndexedDB
  await expect.poll(() => cachedCount(page), { timeout: 30_000 }).toBe(1);

  await page.locator('.cache h2 button').click();
  await expect(page.locator('.cache li')).toHaveCount(1);
  await expect(page.locator('.cache li')).toContainText('cache-60s.wav');

  // 重载（同一个 context，IndexedDB 还在）应当直接吃本地副本
  await page.reload();
  await expect(page.locator('header strong')).toContainText('房间 ', { timeout: 15_000 });
  await waitForPlaying(page);
  expect((await audioState(page)).src).toMatch(/^blob:/);

  // 删掉缓存后回到网络流
  await page.locator('.cache h2 button').click();
  await page.locator('.cache li button.icon').first().click();
  await expect.poll(() => cachedCount(page), { timeout: 15_000 }).toBe(0);
  await expect(page.locator('.cache li')).toHaveCount(0);

  await ctx.close();
});
