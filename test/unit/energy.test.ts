import { describe, expect, it } from 'vitest';
import { SILENT, proceduralEnergy, readEnergy } from '../../src/client/stage/energy';

const SAMPLE_RATE = 48000;
const BINS = 1024;

/** 造一份频谱：指定频段给高值，其余为 0 */
function spectrum(peaks: Array<[number, number]>, value = 255): Uint8Array {
  const s = new Uint8Array(BINS);
  for (const [lo, hi] of peaks) for (let i = lo; i < hi && i < BINS; i++) s[i] = value;
  return s;
}

const binOf = (hz: number) => Math.round((hz / (SAMPLE_RATE / 2)) * BINS);

/**
 * 连着喂若干帧同一份频谱。
 *
 * 一帧 16 ms 只走完攻击的一小段（设计规格定的攻击时长是约 80 ms），
 * 所以断言"能量起来了"必须先走够帧数 —— 拿单帧去比阈值测的是平滑器，
 * 不是频段映射。
 */
function settle(s: Uint8Array, frames = 8): ReturnType<typeof readEnergy> {
  let e = SILENT;
  for (let i = 0; i < frames; i++) e = readEnergy(s, SAMPLE_RATE, e, 16);
  return e;
}

describe('频段能量', () => {
  it('全静音 → 全 0', () => {
    const e = readEnergy(new Uint8Array(BINS), SAMPLE_RATE, SILENT, 16);
    expect(e.level).toBe(0);
    expect(e.bass).toBe(0);
    expect(e.treble).toBe(0);
  });

  it('低频为主时 bass 明显高于 treble', () => {
    const e = settle(spectrum([[binOf(40), binOf(200)]]));
    expect(e.bass).toBeGreaterThan(e.treble);
    expect(e.bass).toBeGreaterThan(0.5);
  });

  it('高频为主时 treble 明显高于 bass', () => {
    const e = settle(spectrum([[binOf(6000), binOf(14000)]]));
    expect(e.treble).toBeGreaterThan(e.bass);
    expect(e.treble).toBeGreaterThan(0.5);
  });

  it('输出恒在 0..1，哪怕是满幅噪声', () => {
    const full = new Uint8Array(BINS).fill(255);
    const e = settle(full);
    for (const v of [e.level, e.bass, e.treble]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('平滑：突起来得快，落下去慢（释放比攻击长）', () => {
    const loud = spectrum([[binOf(40), binOf(200)]]);
    const quiet = new Uint8Array(BINS);

    // 满幅低频，一帧 16 ms 走三步（48 ms）—— 该有明显反应，
    // 不是"要好几秒才动"。但也不该一帧就到位：设计规格定的是约 80 ms
    let up = SILENT;
    for (let i = 0; i < 3; i++) up = readEnergy(loud, SAMPLE_RATE, up, 16);
    const peak = up.bass;
    expect(peak).toBeGreaterThan(0.3);

    // 同样的三步往下走，落得明显比升得慢 —— 这就是"攻击快、释放慢"
    let down = up;
    for (let i = 0; i < 3; i++) down = readEnergy(quiet, SAMPLE_RATE, down, 16);
    expect(down.bass).toBeGreaterThan(peak * 0.5);
  });
});

describe('程序化兜底曲线', () => {
  it('暂停时是静默', () => {
    expect(proceduralEnergy(5000, false)).toEqual(SILENT);
  });

  it('播放时给出 0..1 的缓慢起伏', () => {
    const seen = new Set<number>();
    for (let t = 0; t < 4000; t += 250) {
      const e = proceduralEnergy(t, true);
      expect(e.level).toBeGreaterThanOrEqual(0);
      expect(e.level).toBeLessThanOrEqual(1);
      expect(e.bass).toBeGreaterThanOrEqual(0);
      expect(e.bass).toBeLessThanOrEqual(1);
      seen.add(Math.round(e.level * 100));
    }
    // 确实是"在动"，不是一个常数
    expect(seen.size).toBeGreaterThan(3);
  });
});
