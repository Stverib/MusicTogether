import { test, expect, type Browser } from '@playwright/test';
import {
  audioState,
  createRoom,
  joinRoom,
  makeWav,
  roomCodeOf,
  uploadOne,
  waitForDuration,
  waitForPlaying,
} from './helpers';

/** 两端各自建上下文，模拟两台设备 */
async function twoSides(browser: Browser) {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();
  return { ctxA, ctxB, a, b };
}

test('两端播放位置保持在 1 秒以内', async ({ browser }) => {
  const { ctxA, ctxB, a, b } = await twoSides(browser);
  const code = await createRoom(a, '阿甲');
  await joinRoom(b, '阿乙', code);

  await uploadOne(a, makeWav({ seconds: 20, name: 'sync-20s.wav' }));

  await a.locator('.player .primary').click();
  await waitForPlaying(a);
  await waitForPlaying(b);

  // 让它们跑一会儿，再比较
  await a.waitForTimeout(3000);

  const sa = await audioState(a);
  const sb = await audioState(b);

  expect(sa.exists && sb.exists).toBe(true);
  expect(sa.currentTime).toBeGreaterThan(1);
  expect(Math.abs(sa.currentTime - sb.currentTime)).toBeLessThan(1);

  await ctxA.close();
  await ctxB.close();
});

test('暂停在两端同步，且暂停后位置冻住', async ({ browser }) => {
  const { ctxA, ctxB, a, b } = await twoSides(browser);
  const code = await createRoom(a, '阿甲');
  await joinRoom(b, '阿乙', code);
  await uploadOne(a, makeWav({ seconds: 20, name: 'pause-20s.wav' }));

  await a.locator('.player .primary').click();
  await waitForPlaying(a);
  await waitForPlaying(b);

  await a.locator('.player .primary').click(); // 暂停

  await expect.poll(async () => (await audioState(a)).paused, { timeout: 10_000 }).toBe(true);
  await expect.poll(async () => (await audioState(b)).paused, { timeout: 10_000 }).toBe(true);

  const before = await audioState(b);
  await b.waitForTimeout(1500);
  const after = await audioState(b);

  expect(Math.abs(after.currentTime - before.currentTime)).toBeLessThan(0.3);

  await ctxA.close();
  await ctxB.close();
});

test('拖动进度条在两端同步', async ({ browser }) => {
  const { ctxA, ctxB, a, b } = await twoSides(browser);
  const code = await createRoom(a, '阿甲');
  await joinRoom(b, '阿乙', code);
  await uploadOne(a, makeWav({ seconds: 30, name: 'seek-30s.wav' }));

  await a.locator('.player .primary').click();
  await waitForPlaying(a);
  await waitForPlaying(b);

  // 拿到时长之前进度条的 max 只有 1，这时拖不动（浏览器会把值夹到 1）。
  // 这一步同时也是在验证：歌曲真的解码出了时长。
  await waitForDuration(a, 25);
  await expect
    .poll(async () => Number(await a.locator('.seek').getAttribute('max')), { timeout: 10_000 })
    .toBeGreaterThan(20_000);

  // A 拖到 20 秒附近
  await a.locator('.seek').fill('20000');

  await expect
    .poll(async () => (await audioState(a)).currentTime, { timeout: 10_000 })
    .toBeGreaterThan(15);
  await expect
    .poll(async () => (await audioState(b)).currentTime, { timeout: 10_000 })
    .toBeGreaterThan(15);

  const sa = await audioState(a);
  const sb = await audioState(b);
  expect(Math.abs(sa.currentTime - sb.currentTime)).toBeLessThan(1);

  await ctxA.close();
  await ctxB.close();
});

test('B 也能控制播放（平权）', async ({ browser }) => {
  const { ctxA, ctxB, a, b } = await twoSides(browser);
  const code = await createRoom(a, '阿甲');
  await joinRoom(b, '阿乙', code);
  await uploadOne(a, makeWav({ seconds: 20, name: 'equal-20s.wav' }));

  // B 点播放，A 应当跟着响
  await b.locator('.player .primary').click();
  await waitForPlaying(a);
  await waitForPlaying(b);

  await ctxA.close();
  await ctxB.close();
});

test('后进来的人立刻跟上当前播放位置，不用等同步帧', async ({ browser }) => {
  const { ctxA, ctxB, a, b } = await twoSides(browser);
  const code = await createRoom(a, '阿甲');

  await uploadOne(a, makeWav({ seconds: 40, name: 'late-40s.wav' }));
  await a.locator('.player .primary').click();
  await waitForPlaying(a);
  await a.waitForTimeout(4000);

  const aBefore = await audioState(a);

  // B 这时候才进来
  const joinedAt = Date.now();
  await joinRoom(b, '阿乙', code);
  await waitForPlaying(b);
  const elapsed = Date.now() - joinedAt;

  // 两端要在**同一时刻**比。拿 aBefore 比是错的：那是进房之前的快照，
  // 中间隔着整整一个进房耗时，diff 会等于 elapsed 而不是同步误差 ——
  // 机器一慢就假红，跟同步精度没关系。
  const sa = await audioState(a);
  const sb = await audioState(b);

  // 关键：B 的位置应当已经接近 A，而不是从 0 开始
  expect(sb.currentTime).toBeGreaterThan(2);
  expect(aBefore.currentTime).toBeGreaterThan(2);
  expect(Math.abs(sb.currentTime - sa.currentTime)).toBeLessThan(3);
  // 而且不该是"干等到下一次周期性同步帧"才响的（同步帧间隔 30 秒）
  expect(elapsed).toBeLessThan(15_000);

  await ctxA.close();
  await ctxB.close();
});

test('队列里的歌对两端都可见', async ({ browser }) => {
  const { ctxA, ctxB, a, b } = await twoSides(browser);
  const code = await createRoom(a, '阿甲');
  await joinRoom(b, '阿乙', code);

  await uploadOne(a, makeWav({ seconds: 5, name: 'visible-5s.wav' }));

  await expect(b.locator('.queue li')).toHaveCount(1, { timeout: 15_000 });
  await expect(b.locator('.queue li')).toContainText('visible-5s.wav');

  await ctxA.close();
  await ctxB.close();
});

test('B 点队列里的第二首，两端一起切过去', async ({ browser }) => {
  const { ctxA, ctxB, a, b } = await twoSides(browser);
  const code = await createRoom(a, '阿甲');
  await joinRoom(b, '阿乙', code);

  await uploadOne(a, makeWav({ seconds: 5, name: 'first-5s.wav' }));
  await uploadOne(a, makeWav({ seconds: 6, name: 'second-6s.wav' }), 2);

  // B 点第二首
  await b.locator('.queue li').nth(1).locator('button.link').click();

  await waitForPlaying(a);
  await waitForPlaying(b);

  await expect(a.locator('.player .title')).toContainText('second-6s.wav');
  await expect(b.locator('.player .title')).toContainText('second-6s.wav');

  await ctxA.close();
  await ctxB.close();
});

test('暂停后换一首歌，两端都开始播新歌', async ({ browser }) => {
  const { ctxA, ctxB, a, b } = await twoSides(browser);
  const code = await createRoom(a, '阿甲');
  await joinRoom(b, '阿乙', code);

  await uploadOne(a, makeWav({ seconds: 5, name: 'one.wav' }));
  await uploadOne(a, makeWav({ seconds: 6, name: 'two.wav' }), 2);

  await a.locator('.player .primary').click();
  await waitForPlaying(a);
  await a.locator('.player .primary').click(); // 暂停
  await expect.poll(async () => (await audioState(a)).paused, { timeout: 10_000 }).toBe(true);

  // 切到第二首
  await b.locator('.queue li').nth(1).locator('button.link').click();

  await waitForPlaying(a);
  await waitForPlaying(b);

  await expect(a.locator('.player .title')).toContainText('two.wav');

  await ctxA.close();
  await ctxB.close();
});

test('播放时连接状态指示是绿的', async ({ page }) => {
  await createRoom(page, '阿甲');
  await expect(page.locator('.dot.open')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.banner')).toBeHidden();
});

test('房间码在页面标题区可见', async ({ page }) => {
  const code = await createRoom(page, '阿甲');
  expect(await roomCodeOf(page)).toBe(code);
});

test('把歌从队列移除后，两端都不再显示它', async ({ browser }) => {
  const { ctxA, ctxB, a, b } = await twoSides(browser);
  const code = await createRoom(a, '阿甲');
  await joinRoom(b, '阿乙', code);

  await uploadOne(a, makeWav({ seconds: 5, name: 'remove-me.wav' }));
  await expect(b.locator('.queue li')).toHaveCount(1, { timeout: 15_000 });

  await a.locator('.queue li').first().locator('button.icon').click();

  await expect.poll(async () => a.locator('.queue li').count(), { timeout: 15_000 }).toBe(0);
  await expect.poll(async () => b.locator('.queue li').count(), { timeout: 15_000 }).toBe(0);

  await ctxA.close();
  await ctxB.close();
});
