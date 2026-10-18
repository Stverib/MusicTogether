import { describe, it, expect } from 'vitest';
import {
  positionAt, shouldResync, pauseAnchor, resumeAnchor, seekAnchor, startAnchor, emptyPlayback,
} from '../../src/shared/playback';
import type { Playback } from '../../src/shared/types';

const T0 = 1_700_000_000_000;

function playing(): Playback {
  return { trackId: 't1', positionMs: 0, anchorAt: T0, isPlaying: true, seq: 1 };
}

describe('positionAt', () => {
  it('播放中：位置随服务端时间线性推进', () => {
    expect(positionAt(playing(), T0)).toBe(0);
    expect(positionAt(playing(), T0 + 5_000)).toBe(5_000);
    expect(positionAt(playing(), T0 + 61_500)).toBe(61_500);
  });

  it('暂停中：位置恒定不动', () => {
    const paused: Playback = { ...playing(), positionMs: 12_000, isPlaying: false };
    expect(positionAt(paused, T0)).toBe(12_000);
    expect(positionAt(paused, T0 + 999_999)).toBe(12_000);
  });

  it('没有曲目：位置为 0，不随时间推进', () => {
    expect(positionAt(emptyPlayback(), T0 + 10_000)).toBe(0);
  });

  it('时间回退（时钟抖动）不产生负增量', () => {
    expect(positionAt(playing(), T0 - 5_000)).toBe(0);
  });
});

describe('shouldResync', () => {
  it('偏差小于阈值不纠正', () => {
    expect(shouldResync(10_000, 10_500)).toBe(false);
  });
  it('偏差超过默认 2 秒阈值才纠正', () => {
    expect(shouldResync(10_000, 12_100)).toBe(true);
    expect(shouldResync(10_000, 7_900)).toBe(true);
  });
  it('正负偏差对称处理', () => {
    expect(shouldResync(10_000, 8_500)).toBe(false);
    expect(shouldResync(8_500, 10_000)).toBe(false);
  });
  it('恰好等于阈值不纠正', () => {
    expect(shouldResync(10_000, 12_000)).toBe(false);
  });
});

describe('状态迁移', () => {
  it('pauseAnchor 固化当前位置并停止推进', () => {
    const p = pauseAnchor(playing(), T0 + 30_000);
    expect(p.isPlaying).toBe(false);
    expect(p.positionMs).toBe(30_000);
    expect(positionAt(p, T0 + 999_999)).toBe(30_000);
  });

  it('resumeAnchor 从冻结位置重新起算', () => {
    const paused = pauseAnchor(playing(), T0 + 30_000);
    const resumed = resumeAnchor(paused, T0 + 60_000);
    expect(resumed.isPlaying).toBe(true);
    expect(positionAt(resumed, T0 + 60_000)).toBe(30_000);
    expect(positionAt(resumed, T0 + 65_000)).toBe(35_000);
  });

  it('seekAnchor 跳到目标位置，负数归零', () => {
    const s = seekAnchor(playing(), T0 + 10_000, 45_000);
    expect(positionAt(s, T0 + 10_000)).toBe(45_000);
    expect(seekAnchor(playing(), T0, -500).positionMs).toBe(0);
  });

  it('seekAnchor 保持播放状态不变', () => {
    expect(seekAnchor(playing(), T0, 5_000).isPlaying).toBe(true);
    const paused = pauseAnchor(playing(), T0);
    expect(seekAnchor(paused, T0, 5_000).isPlaying).toBe(false);
  });

  it('seek 到当前位置不改变结果', () => {
    const s = seekAnchor(playing(), T0 + 10_000, positionAt(playing(), T0 + 10_000));
    expect(positionAt(s, T0 + 10_000)).toBe(positionAt(playing(), T0 + 10_000));
  });

  it('startAnchor 切换曲目并从 0 开始播', () => {
    const s = startAnchor('t2', T0 + 99_000);
    expect(s.trackId).toBe('t2');
    expect(s.positionMs).toBe(0);
    expect(s.isPlaying).toBe(true);
    expect(positionAt(s, T0 + 102_000)).toBe(3_000);
  });

  it('每次迁移 seq 单调递增（用于丢弃乱序消息）', () => {
    let a = playing();
    const seqs = [a.seq];
    a = pauseAnchor(a, T0 + 1_000); seqs.push(a.seq);
    a = resumeAnchor(a, T0 + 2_000); seqs.push(a.seq);
    a = seekAnchor(a, T0 + 3_000, 5_000); seqs.push(a.seq);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);
  });
});
