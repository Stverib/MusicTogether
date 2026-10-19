/**
 * 画质档位。
 *
 * 档位是**每台设备自己的** —— 不上行、不进房间状态。画质是设备的事，
 * 主题才是房间的事（主题是房间级、服务端权威，见 docs/spec.md §1.2 的 D13）。
 */
export type QualityTier = 'high' | 'medium' | 'low';

export const TIERS: Record<QualityTier, { maxPixelRatio: number; particles: number }> = {
  high: { maxPixelRatio: 2, particles: 1200 },
  medium: { maxPixelRatio: 1.5, particles: 500 },
  low: { maxPixelRatio: 1, particles: 150 },
};

/** 低于 ~42 fps 就降一档。24 ms 是 41.7 fps 的帧时间 */
const DEGRADE_ABOVE_MS = 24;

const ORDER: QualityTier[] = ['low', 'medium', 'high'];

const LS_TIER = 'mt_quality';

export function guessTier(cores: number, coarsePointer: boolean): QualityTier {
  // 手机上核数不可信（大小核混排），一律从中档起步，靠实测再降
  if (coarsePointer) return 'medium';
  if (cores >= 8) return 'high';
  if (cores >= 4) return 'medium';
  return 'low';
}

/** 只降不升：升档会在临界点上反复横跳，那种抖动比一直低画质更难忍 */
export function degrade(tier: QualityTier): QualityTier {
  const i = ORDER.indexOf(tier);
  return ORDER[Math.max(0, i - 1)]!;
}

export function shouldDegrade(avgFrameMs: number): boolean {
  return avgFrameMs > DEGRADE_ABOVE_MS;
}

/** 档位是**每台设备自己的**，不上行、不进房间状态 —— 画质是设备的事，主题才是房间的事 */
export function loadTier(): QualityTier {
  try {
    const v = localStorage.getItem(LS_TIER);
    return v === 'high' || v === 'medium' || v === 'low' ? v : pickInitialTier();
  } catch {
    return 'medium';
  }
}

export function saveTier(tier: QualityTier): void {
  try {
    localStorage.setItem(LS_TIER, tier);
  } catch {
    // 存不下就算了，不影响任何功能
  }
}

function pickInitialTier(): QualityTier {
  const cores = navigator.hardwareConcurrency ?? 4;
  const coarse = matchMedia?.('(pointer: coarse)').matches ?? false;
  return guessTier(cores, coarse);
}
