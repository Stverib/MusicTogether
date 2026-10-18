import { test, expect, type Browser } from '@playwright/test';
import { createRoom } from './helpers';

/** 建一个房间，返回房间码；顺便拿到那个页面用来对照 */
async function aRoomWith(browser: Browser) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const code = await createRoom(page, '阿甲');
  return { ctx, page, code };
}

/** 模拟"收到链接的人"：一个干净的浏览器上下文 */
async function guest(browser: Browser) {
  const ctx = await browser.newContext();
  return { ctx, page: await ctx.newPage() };
}

test('打开分享链接时房间码已经填好，只剩昵称要填', async ({ browser }) => {
  const host = await aRoomWith(browser);
  const g = await guest(browser);

  await g.page.goto(`/r/${host.code}`);

  await expect(g.page.getByLabel('房间码')).toHaveValue(host.code);
  await expect(g.page.getByRole('button', { name: '加入' })).toBeEnabled();
  // 文案换成邀请口吻，让人知道这是别人拉他进来的
  await expect(g.page.locator('.tagline')).toContainText('邀请');

  await g.page.getByLabel('你的昵称').fill('阿乙');
  await g.page.getByRole('button', { name: '加入' }).click();

  await expect(g.page.locator('header strong')).toContainText(host.code);
  // 房主那边也看到人了
  await expect(host.page.locator('.members')).toContainText('阿乙');

  await host.ctx.close();
  await g.ctx.close();
});

test('之前填过昵称的人点链接直接进房间，一个字段都不用碰', async ({ browser }) => {
  const host = await aRoomWith(browser);
  const g = await guest(browser);

  // 让这个人先用过一次，浏览器里留下昵称
  await createRoom(g.page, '阿乙');

  await g.page.goto(`/r/${host.code}`);

  await expect(g.page.locator('header strong')).toContainText(host.code, { timeout: 15_000 });
  await expect(g.page.locator('.members')).toContainText('阿甲');

  await host.ctx.close();
  await g.ctx.close();
});

test('加入之后地址栏不再挂着房间码', async ({ browser }) => {
  const host = await aRoomWith(browser);
  const g = await guest(browser);

  await g.page.goto(`/r/${host.code}`);
  await g.page.getByLabel('你的昵称').fill('阿乙');
  await g.page.getByRole('button', { name: '加入' }).click();
  await expect(g.page.locator('header strong')).toContainText(host.code);

  // 房间码是秘密，没必要一直留在历史和截图里
  expect(new URL(g.page.url()).pathname).toBe('/');
  // 但刷新还得回得来
  await g.page.reload();
  await expect(g.page.locator('header strong')).toContainText(host.code, { timeout: 15_000 });

  await host.ctx.close();
  await g.ctx.close();
});

test('分享按钮把链接复制到剪贴板', async ({ browser }) => {
  const ctx = await browser.newContext({
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  // 桌面 Chromium 上 navigator.share 存在时会弹系统面板，把测试挂住。
  // 这条用例专测剪贴板这条路，所以先把它拿掉。
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'share', { value: undefined, configurable: true });
  });
  const page = await ctx.newPage();
  const code = await createRoom(page, '阿甲');

  await page.getByTitle('分享房间').click();
  await expect(page.locator('.toast')).toContainText('已复制');

  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    `http://127.0.0.1:8788/r/${code}`,
  );

  await ctx.close();
});

test('手机上有系统分享面板时走系统分享', async ({ browser }) => {
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => {
    (window as unknown as { __shared: unknown }).__shared = null;
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: (data: unknown) => {
        (window as unknown as { __shared: unknown }).__shared = data;
        return Promise.resolve();
      },
    });
  });
  const page = await ctx.newPage();
  const code = await createRoom(page, '阿甲');

  await page.getByTitle('分享房间').click();
  await expect(page.locator('.toast')).toContainText('已分享');

  const shared = (await page.evaluate(
    () => (window as unknown as { __shared: { url: string } }).__shared,
  )) as { url: string };
  expect(shared.url).toBe(`http://127.0.0.1:8788/r/${code}`);

  await ctx.close();
});

test('链接里的房间码不合法时，安静地退回普通加入页', async ({ page }) => {
  await page.goto('/r/abc'); // 长度不对

  await expect(page.getByLabel('房间码')).toHaveValue('');
  await expect(page.locator('.tagline')).toContainText('进度条保持同步');
});

test('链接指向不存在的房间时给出提示', async ({ page }) => {
  await page.goto('/r/ZZZZZZ');

  await expect(page.getByLabel('房间码')).toHaveValue('ZZZZZZ');
  await page.getByLabel('你的昵称').fill('阿甲');
  await page.getByRole('button', { name: '加入' }).click();
  await expect(page.getByText('房间不存在')).toBeVisible();
});
