import { test, expect, type Page } from '@playwright/test';
import { createRoom } from './helpers';

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
