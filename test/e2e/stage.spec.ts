import { test, expect, type Page } from '@playwright/test';
import { createRoom, makeWav, uploadOne, waitForPlaying } from './helpers';

/** 让 WebGL 拿不到 context，模拟老设备 / 驱动被禁 */
async function killWebgl(page: Page) {
  await page.addInitScript(() => {
    const real = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (
      this: HTMLCanvasElement,
      id: string,
      ...rest: unknown[]
    ) {
      if (typeof id === 'string' && id.startsWith('webgl')) return null;
      return (real as (...a: unknown[]) => unknown).apply(this, [id, ...rest]);
    } as typeof real;
  });
}

test('进入房间后出现场景画布，加入页没有', async ({ page }) => {
  await expect(page.locator('canvas.stage-canvas')).toHaveCount(0);
  await createRoom(page, '阿甲');
  await expect(page.locator('canvas.stage-canvas')).toHaveCount(1);
  // 画布是纯装饰，不该被读屏软件念出来
  await expect(page.locator('canvas.stage-canvas')).toHaveAttribute('aria-hidden', 'true');
});

test('拿不到 WebGL 时应用照常可用，只是没有场景', async ({ page }) => {
  await killWebgl(page);
  await createRoom(page, '阿甲');
  await expect(page.locator('canvas.stage-canvas')).toHaveCount(0);
  // 该在的都还在
  await expect(page.locator('header strong')).toBeVisible();
});

test('three 的 chunk 加载失败时应用照常可用', async ({ browser }) => {
  // 必须挡住 Service Worker：它在页面加载时注册，之后由它去取 three 那个 chunk，
  // 而 page.route 拦不到 SW 发起的请求 —— 不挡的话这条用例会静默地什么都没测到，
  // 变成一条永远绿的装饰
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  const page = await ctx.newPage();

  await page.route('**/three-*.js', (r) => r.abort());
  await createRoom(page, '阿甲');
  await expect(page.locator('canvas.stage-canvas')).toHaveCount(0);
  await expect(page.locator('header strong')).toBeVisible();

  await ctx.close();
});

test('画布上带着当前主题，默认是 dawn', async ({ page }) => {
  await createRoom(page, '阿甲');
  await expect(page.locator('canvas.stage-canvas')).toHaveAttribute('data-theme', 'dawn');
  await expect(page.locator('canvas.stage-canvas')).toHaveAttribute('data-stage', 'ready');
});

test('只有一个主题时不显示切换器', async ({ page }) => {
  await createRoom(page, '阿甲');
  await expect(page.locator('.theme-switch')).toHaveCount(0);
});

test('客户端能容忍未知主题，场景退回默认而不是崩掉', async ({ page }) => {
  await createRoom(page, '阿甲');
  // 服务端会拒掉非法主题，但客户端不该依赖这一点 —— 边界是双向的
  const applied = await page.evaluate(() => {
    const canvas = document.querySelector('canvas.stage-canvas');
    return canvas?.getAttribute('data-theme') ?? null;
  });
  expect(applied).toBe('dawn');
  await expect(page.locator('header strong')).toBeVisible();
});

test('播放时场景的能量观测点动起来，暂停后归零', async ({ page }) => {
  await createRoom(page, '阿甲');
  await uploadOne(page, makeWav({ seconds: 60, name: 'energy-60s.wav' }));

  const energy = page.locator('canvas.stage-canvas');
  // 没播放时能量恒为 0
  await expect(energy).toHaveAttribute('data-energy', '0.00');

  // 点播放同时触发第一次 pointerdown，分析链就在那一刻挂上
  await page.locator('.player .primary').click();
  await waitForPlaying(page);

  // 走兜底曲线也会动，所以这条测的是"整条链没断" ——
  // RAF 在跑、能量算出来了、观测点写进去了。不是"用的是 Web Audio"
  await expect.poll(() => energy.getAttribute('data-energy'), { timeout: 15_000 }).not.toBe('0.00');
});

test('画布上挂着画质档位与实测帧时间', async ({ page }) => {
  await createRoom(page, '阿甲');
  const canvas = page.locator('canvas.stage-canvas');

  // 档位在挂载时就定了，来自 localStorage 或设备推断
  await expect(canvas).toHaveAttribute('data-quality', /^(high|medium|low)$/);
  // 帧时间是 2 秒一个滚动窗口，窗口一到才挂出来
  await expect(canvas).toHaveAttribute('data-frame-ms', /\d/, { timeout: 10_000 });
});

test('切歌时场景进入过渡，结束后回到稳态', async ({ page }) => {
  await createRoom(page, '阿甲');
  await uploadOne(page, makeWav({ seconds: 60, name: 'a-60s.wav' }));

  const canvas = page.locator('canvas.stage-canvas');
  await expect(canvas).not.toHaveAttribute('data-transition', 'song');

  await page.locator('.queue li').first().click();
  await expect(canvas).toHaveAttribute('data-transition', 'song', { timeout: 10_000 });
  // 900 ms 后自己收掉，不会一直挂着
  await expect(canvas).not.toHaveAttribute('data-transition', 'song', { timeout: 10_000 });
});

test('prefers-reduced-motion 下不跑动画，但场景仍在', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await createRoom(page, '阿甲');
  await expect(page.locator('canvas.stage-canvas')).toHaveAttribute('data-motion', 'reduced');
});
