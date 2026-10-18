import { expect, type Page } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeCode } from '../../src/shared/codes';

/** 建一个房间，返回房间码 */
export async function createRoom(page: Page, name: string): Promise<string> {
  await page.goto('/');
  await page.getByLabel('你的昵称').fill(name);
  await page.getByRole('button', { name: '创建一个新房间' }).click();
  await expect(page.locator('header strong')).toContainText('房间 ', { timeout: 15_000 });
  const header = await page.locator('header strong').textContent();
  return header!.replace('房间 ', '').trim();
}

export async function joinRoom(page: Page, name: string, code: string): Promise<void> {
  await page.goto('/');
  await page.getByLabel('你的昵称').fill(name);
  await page.getByLabel('房间码').fill(code);
  await page.getByRole('button', { name: '加入' }).click();
  // 输入框会把房间码归一化（大小写、分隔符都会被吃掉），
  // 所以断言也要拿归一化之后的形状，否则粘贴 "d-t-p-5-t-z" 这种会误报失败
  await expect(page.locator('header strong')).toContainText(normalizeCode(code), {
    timeout: 15_000,
  });
}

/** 房间码显示在 header 里，取出来 */
export async function roomCodeOf(page: Page): Promise<string> {
  const header = await page.locator('header strong').textContent();
  return header!.replace('房间 ', '').trim();
}

/**
 * 生成一个合法的 WAV 文件，内容是一段极轻的正弦波。
 *
 * 不用静音：某些浏览器对全静音轨道的解码路径不同，
 * 有实际波形更能反映真实播放行为。
 *
 * name 一定要给不同值：同名文件连续 setInputFiles 时，浏览器会因为
 * 输入框的值没变而不触发 change，第二次上传会静默消失。
 */
export function makeWav(
  opts: { seconds?: number; name?: string; freq?: number; rate?: number } = {},
): string {
  const { seconds = 10, name = 'tone.wav', freq = 220, rate = 8000 } = opts;
  const samples = rate * seconds;
  const buf = Buffer.alloc(44 + samples * 2);

  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16); // fmt chunk 大小
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // 单声道
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36);
  buf.writeUInt32LE(samples * 2, 40);

  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(Math.round(Math.sin((i * freq * 2 * Math.PI) / rate) * 8000), 44 + i * 2);
  }

  const dir = mkdtempSync(join(tmpdir(), 'mt-e2e-'));
  const path = join(dir, name);
  writeFileSync(path, buf);
  return path;
}

/** 上传一首歌，并等到队列里确实有 expectedCount 首 */
export async function uploadOne(
  page: Page,
  filePath: string,
  expectedCount = 1,
): Promise<void> {
  await page.locator('input[accept="audio/*"]').setInputFiles(filePath);
  await page.getByRole('button', { name: '全部上传' }).click();
  await expect(page.locator('.queue li')).toHaveCount(expectedCount, { timeout: 30_000 });
}

/** 读 <audio> 的真实播放状态 */
export async function audioState(page: Page) {
  return page.evaluate(() => {
    const el = document.querySelector('audio') as HTMLAudioElement | null;
    return {
      exists: el !== null,
      currentTime: el?.currentTime ?? -1,
      paused: el?.paused ?? true,
      src: el?.currentSrc ?? '',
      readyState: el?.readyState ?? -1,
    };
  });
}

/**
 * 等两端都真的开始出声。
 *
 * 光看 currentTime / paused 是不够的：播放器在元数据到位之前就会
 * 设好 currentTime 并调 play()，此时 readyState 还是 0，
 * duration 也还不存在。必须等到真的有数据可解码。
 */
export async function waitForPlaying(page: Page, timeout = 30_000): Promise<void> {
  await page.waitForFunction(
    () => {
      const el = document.querySelector('audio') as HTMLAudioElement | null;
      return !!el && !el.paused && el.readyState >= 2 && el.currentTime > 0.2;
    },
    undefined,
    { timeout },
  );
}

/** 等播放器拿到真实时长 —— 进度条在时长未知时 max 只有 1，拖不动 */
export async function waitForDuration(page: Page, seconds: number, timeout = 15_000): Promise<void> {
  await page.waitForFunction(
    (min) => {
      const el = document.querySelector('audio') as HTMLAudioElement | null;
      return !!el && Number.isFinite(el.duration) && el.duration >= min;
    },
    seconds,
    { timeout },
  );
}
