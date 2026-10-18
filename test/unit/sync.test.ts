import { describe, it, expect } from 'vitest';
import { planPlayback, streamUrl } from '../../src/client/sync';
import type { Playback } from '../../src/shared/types';

const T0 = 1_700_000_000_000;
const RTT = 100;

function anchor(over: Partial<Playback> = {}): Playback {
  return { trackId: 't1', positionMs: 0, anchorAt: T0, isPlaying: true, seq: 1, ...over };
}

const cur = (trackId: string | null, currentTime: number) => ({ trackId, currentTime });

describe('planPlayback', () => {
  it('切到新曲目：需要 load', () => {
    const plan = planPlayback(cur('t0', 30), anchor({ trackId: 't1' }), T0, RTT);
    expect(plan.action).toBe('load');
    // 锚点说「服务端时刻 T0 时位置是 0」，而消息走了半个 RTT 才到，
    // 所以此刻真实位置已经是 rtt/2 = 50ms
    expect(plan.positionMs).toBe(50);
    expect(plan.isPlaying).toBe(true);
  });

  it('当前没在播任何歌，收到第一首也要 load', () => {
    expect(planPlayback(cur(null, 0), anchor(), T0, RTT).action).toBe('load');
  });

  it('同一首歌偏差很小：什么都不做', () => {
    expect(planPlayback(cur('t1', 5.0), anchor({ positionMs: 5_000 }), T0, RTT).action).toBe('none');
  });

  it('同一首歌偏差超过 2 秒：seek 到推算位置', () => {
    const plan = planPlayback(cur('t1', 0.5), anchor({ positionMs: 30_000 }), T0, RTT);
    expect(plan.action).toBe('seek');
    expect(plan.positionMs).toBe(30_050); // 30000 + rtt/2
  });

  it('偏差刚好 2 秒不触发 seek（阈值是严格大于）', () => {
    expect(planPlayback(cur('t1', 28.0), anchor({ positionMs: 30_000 }), T0, 0).action).toBe('none');
  });

  it('把网络单程延迟算进去，避免系统性落后', () => {
    // 锚点在 10 秒前，服务端在收到消息那一刻的真实位置是 10000 + 50 = 10050
    const plan = planPlayback(cur('t1', 0), anchor({ positionMs: 10_000 }), T0, RTT);
    expect(plan.positionMs).toBe(10_050);
  });

  it('RTT 未知时按 0 处理，不会崩', () => {
    expect(planPlayback(cur('t1', 0.5), anchor({ positionMs: 30_000 }), T0, 0).positionMs).toBe(
      30_000,
    );
  });

  it('RTT 为负数时也不产生负偏移', () => {
    expect(planPlayback(cur('t1', 0.5), anchor({ positionMs: 30_000 }), T0, -50).positionMs).toBe(
      30_000,
    );
  });

  it('暂停状态下目标位置恒定，不随 serverNow 推进', () => {
    const plan = planPlayback(
      cur('t1', 20),
      anchor({ positionMs: 20_000, isPlaying: false }),
      T0 + 99_999,
      RTT,
    );
    expect(plan.positionMs).toBe(20_000);
    expect(plan.isPlaying).toBe(false);
  });

  it('没有曲目时给出空计划', () => {
    const plan = planPlayback(cur('t1', 5), anchor({ trackId: null, isPlaying: false }), T0, RTT);
    expect(plan.action).toBe('load');
    expect(plan.positionMs).toBe(0);
    expect(plan.isPlaying).toBe(false);
  });

  it('本地进度落后时 seek 是向后跳，不会一直往前追', () => {
    // 本地 60 秒，服务端只到 10 秒 —— 说明本地跑飞了
    const plan = planPlayback(cur('t1', 60), anchor({ positionMs: 10_000 }), T0, 0);
    expect(plan.action).toBe('seek');
    expect(plan.positionMs).toBe(10_000);
  });

  it('返回的 isPlaying 始终反映服务端锚点，而不是本地状态', () => {
    expect(planPlayback(cur('t1', 5), anchor({ isPlaying: false }), T0, RTT).isPlaying).toBe(false);
    expect(planPlayback(cur('t1', 5), anchor({ isPlaying: true }), T0, RTT).isPlaying).toBe(true);
  });
});

describe('streamUrl', () => {
  it('拼出房间内的流地址', () => {
    expect(streamUrl('K7M2QX', 'abc')).toBe('/api/rooms/K7M2QX/tracks/abc/stream');
  });

  it('是同源相对路径（不发跨源请求）', () => {
    expect(streamUrl('K7M2QX', 'abc').startsWith('/')).toBe(true);
    expect(streamUrl('K7M2QX', 'abc')).not.toContain('http');
  });
});
