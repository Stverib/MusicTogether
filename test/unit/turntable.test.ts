import { describe, expect, it } from 'vitest';
import { spin } from '../../src/client/stage/turntable';

describe('唱盘转角', () => {
  it('暂停时一点都不转', () => {
    expect(spin(1.23, 16, false)).toBe(1.23);
  });

  it('播放时按时间累加', () => {
    const a = spin(0, 1000, true);
    expect(a).toBeGreaterThan(0);
    // 同样的时长再来一次，增量一致
    expect(spin(a, 1000, true) - a).toBeCloseTo(a, 6);
  });

  it('长间隔被夹住，切后台回来不会突然转好几圈', () => {
    const one = spin(0, 16, true) - 0;
    const huge = spin(0, 60_000, true);
    expect(huge).toBeLessThan(one * 10);
  });

  it('角度始终绕回 [0, 2π)', () => {
    let a = 0;
    for (let i = 0; i < 500; i++) a = spin(a, 100, true);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(Math.PI * 2);
  });
});
