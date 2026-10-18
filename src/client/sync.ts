import { positionAt, shouldResync } from '../shared/playback';
import type { Playback } from '../shared/types';

export type PlayerPlan = {
  action: 'load' | 'seek' | 'none';
  positionMs: number;
  isPlaying: boolean;
};

/**
 * 纯函数：给定本地播放器的当前状态与服务端锚点，决定要做什么。
 *
 * 抽成不依赖 store 与 DOM 的独立模块，是为了能脱离 <audio> 测试同步逻辑 ——
 * 这是整个项目最值得测试的一段代码。
 *
 * @param rttMs 一次往返的估算值。加上它的一半，可以让"目标位置"不系统性地落后。
 */
export function planPlayback(
  current: { trackId: string | null; currentTime: number },
  next: Playback,
  serverNow: number,
  rttMs: number,
): PlayerPlan {
  const targetMs = positionAt(next, serverNow + Math.max(0, rttMs) / 2);

  if (next.trackId === null) {
    return { action: 'load', positionMs: 0, isPlaying: false };
  }

  if (current.trackId !== next.trackId) {
    return { action: 'load', positionMs: targetMs, isPlaying: next.isPlaying };
  }

  if (shouldResync(current.currentTime * 1000, targetMs)) {
    return { action: 'seek', positionMs: targetMs, isPlaying: next.isPlaying };
  }

  return { action: 'none', positionMs: targetMs, isPlaying: next.isPlaying };
}

/** 播放地址。?n= 只是给缓存和调试看的，服务端不从它取类型。 */
export function streamUrl(roomCode: string, trackId: string): string {
  return `/api/rooms/${roomCode}/tracks/${trackId}/stream`;
}
