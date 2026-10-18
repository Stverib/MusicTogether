import { test, expect } from '@playwright/test';
import { createRoom, joinRoom, roomCodeOf } from './helpers';

test('两个人能通过房间码配对', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();

  const code = await createRoom(a, '阿甲');
  await joinRoom(b, '阿乙', code);

  // 两边都看到对方
  await expect(a.locator('.members')).toContainText('阿乙');
  await expect(b.locator('.members')).toContainText('阿甲');

  await ctxA.close();
  await ctxB.close();
});

test('房间码不存在时给出提示', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('你的昵称').fill('阿甲');
  await page.getByLabel('房间码').fill('ZZZZZZ');
  await page.getByRole('button', { name: '加入' }).click();
  await expect(page.getByText('房间不存在')).toBeVisible();
});

test('房间码不区分大小写，也容忍分隔符', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();

  const code = await createRoom(a, '阿甲');
  const sloppy = code.toLowerCase().split('').join('-');
  await joinRoom(b, '阿乙', sloppy);

  await expect(b.locator('.members')).toContainText('阿甲');
  await ctxA.close();
  await ctxB.close();
});

test('刷新页面后自动回到原来的房间', async ({ page }) => {
  const code = await createRoom(page, '阿甲');
  await page.reload();
  await expect(page.locator('header strong')).toContainText(code, { timeout: 15_000 });
});

test('离开房间后回到加入页', async ({ page }) => {
  await createRoom(page, '阿甲');
  await page.getByTitle('离开房间').click();
  await expect(page.getByRole('button', { name: '创建一个新房间' })).toBeVisible();
});

test('昵称会显示在成员列表里，且标出自己', async ({ page }) => {
  await createRoom(page, '阿甲');
  const members = page.locator('.members');
  await expect(members).toContainText('阿甲');
  await expect(members).toContainText('（你）');
});

test('房间码是 6 位、只含 Crockford 字母表内的字符', async ({ page }) => {
  const code = await createRoom(page, '阿甲');
  expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}$/);
});

test('退出后刷新不会自动回到已离开的房间', async ({ page }) => {
  await createRoom(page, '阿甲');
  await page.getByTitle('离开房间').click();
  await page.reload();
  await expect(page.getByRole('button', { name: '创建一个新房间' })).toBeVisible();
});

test('空昵称也能加入，会退回默认名', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('房间码').fill('ZZZZZZ');
  // 不填昵称，直接建房间
  await page.getByRole('button', { name: '创建一个新房间' }).click();
  await expect(page.locator('header strong')).toContainText('房间 ');
  await expect(page.locator('.members')).toContainText('匿名');
});

test('房间码长度不足时加入按钮不可点', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('你的昵称').fill('阿甲');
  await page.getByLabel('房间码').fill('ABC');
  await expect(page.getByRole('button', { name: '加入' })).toBeDisabled();
});

test('同一个浏览器开两个标签页是同一个身份', async ({ context }) => {
  const a = await context.newPage();
  const code = await createRoom(a, '阿甲');

  const b = await context.newPage();
  await b.goto('/');
  // 共享 localStorage，所以第二个标签页会自动进同一个房间
  await expect(b.locator('header strong')).toContainText(code, { timeout: 15_000 });

  expect(await roomCodeOf(b)).toBe(code);
});
