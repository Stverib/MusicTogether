import type { Playback } from './types';

/** 距目标位置超过这个毫秒数才动手，避免频繁 seek 产生爆音 */
export const RESYNC_THRESHOLD_MS = 2000;

/**
 * 在服务端时刻 now，锚点所指向的播放位置。
 * 暂停时恒定不动；播放时随服务端时间线性推进。
 */
export function positionAt(anchor: Playback, now: number): number {
  if (!anchor.isPlaying || anchor.trackId === null) return anchor.positionMs;
  return anchor.positionMs + Math.max(0, now - anchor.anchorAt);
}

export function shouldResync(localMs: number, targetMs: number, thresholdMs = RESYNC_THRESHOLD_MS): boolean {
  return Math.abs(localMs - targetMs) > thresholdMs;
}

/** 暂停：把推算出来的位置固化下来 */
export function pauseAnchor(anchor: Playback, now: number): Playback {
  return {
    ...anchor,
    positionMs: positionAt(anchor, now),
    anchorAt: now,
    isPlaying: false,
    seq: anchor.seq + 1,
  };
}

/** 继续：从冻结位置重新起算 */
export function resumeAnchor(anchor: Playback, now: number): Playback {
  return { ...anchor, anchorAt: now, isPlaying: true, seq: anchor.seq + 1 };
}

export function seekAnchor(anchor: Playback, now: number, positionMs: number): Playback {
  return {
    ...anchor,
    positionMs: Math.max(0, Math.floor(positionMs)),
    anchorAt: now,
    isPlaying: anchor.isPlaying,
    seq: anchor.seq + 1,
  };
}

export function startAnchor(trackId: string, now: number): Playback {
  return { trackId, positionMs: 0, anchorAt: now, isPlaying: true, seq: 0 };
}

export function emptyPlayback(): Playback {
  return { trackId: null, positionMs: 0, anchorAt: 0, isPlaying: false, seq: 0 };
}
