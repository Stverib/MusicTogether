import { describe, expect, it } from 'vitest';
import { degrade, guessTier, shouldDegrade, TIERS } from '../../src/client/stage/quality';

describe('画质档位', () => {
  it('触摸设备一律从中档起步，不看核数', () => {
    expect(guessTier(16, true)).toBe('medium');
    expect(guessTier(2, true)).toBe('medium');
  });

  it('桌面按核数分档', () => {
    expect(guessTier(8, false)).toBe('high');
    expect(guessTier(4, false)).toBe('medium');
    expect(guessTier(2, false)).toBe('low');
  });

  it('降级只往下走，到底就停在 low', () => {
    expect(degrade('high')).toBe('medium');
    expect(degrade('medium')).toBe('low');
    expect(degrade('low')).toBe('low');
  });

  it('帧时间超过 24 ms 才降', () => {
    expect(shouldDegrade(16)).toBe(false);
    expect(shouldDegrade(24)).toBe(false);
    expect(shouldDegrade(25)).toBe(true);
  });

  it('档位越高，像素比与粒子数只增不减', () => {
    expect(TIERS.high.particles).toBeGreaterThan(TIERS.medium.particles);
    expect(TIERS.medium.particles).toBeGreaterThan(TIERS.low.particles);
    expect(TIERS.high.maxPixelRatio).toBeGreaterThanOrEqual(TIERS.medium.maxPixelRatio);
    expect(TIERS.medium.maxPixelRatio).toBeGreaterThanOrEqual(TIERS.low.maxPixelRatio);
  });
});
