import { RESYNC_THRESHOLD_MS, positionAt, shouldResync } from '../shared/playback';
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
 */
export function planPlayback(
  current: { trackId: string | null; currentTime: number },
  next: Playback,
  serverNow: number,
  thresholdMs = RESYNC_THRESHOLD_MS,
): PlayerPlan {
  // 不补偿网络延迟：WebSocket 没有 RTT 测量，拿别的间隔来猜只会引入系统性偏差。
  // 局域网的单程延迟远小于 D5 的 ±1 秒，直接用服务端时刻即可。
  const targetMs = positionAt(next, serverNow);

  if (next.trackId === null) {
    return { action: 'load', positionMs: 0, isPlaying: false };
  }

  if (current.trackId !== next.trackId) {
    return { action: 'load', positionMs: targetMs, isPlaying: next.isPlaying };
  }

  if (shouldResync(current.currentTime * 1000, targetMs, thresholdMs)) {
    return { action: 'seek', positionMs: targetMs, isPlaying: next.isPlaying };
  }

  return { action: 'none', positionMs: targetMs, isPlaying: next.isPlaying };
}

/** 播放地址。?n= 只是给缓存和调试看的，服务端不从它取类型。 */
export function streamUrl(roomCode: string, trackId: string): string {
  return `/api/rooms/${roomCode}/tracks/${trackId}/stream`;
}
