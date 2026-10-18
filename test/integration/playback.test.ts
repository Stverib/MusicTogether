import { describe, it, expect } from 'vitest';
import { member, nextOfType, roomWithMembers, uploadTrack } from './helpers';

describe('播放控制', () => {
  it('play 让所有人切到同一首，并从 0 开始播', async () => {
    const { code, members } = await roomWithMembers(['阿甲', '阿乙']);
    const [a, b] = members as [typeof members[0], typeof members[0]];
    const trackId = await uploadTrack(code, a.cookie, '晴天.mp3');

    a.ws.send(JSON.stringify({ type: 'play', trackId }));

    for (const who of [a, b]) {
      const frame = await nextOfType(who.next, 'playback');
      expect(frame.playback.trackId).toBe(trackId);
      expect(frame.playback.isPlaying).toBe(true);
      expect(frame.playback.positionMs).toBe(0);
      expect(typeof frame.serverNow).toBe('number');
    }
  });

  it('发起者自己也收到广播（服务端权威，不做本地乐观更新）', async () => {
    const { code, members } = await roomWithMembers(['阿甲']);
    const a = members[0]!;
    const trackId = await uploadTrack(code, a.cookie, 'a.mp3');

    a.ws.send(JSON.stringify({ type: 'play', trackId }));
    const frame = await nextOfType(a.next, 'playback');
    expect(frame.playback.trackId).toBe(trackId);
  });

  it('pause 后再 resume，从暂停处继续而不是回到 0', async () => {
    const { code, members } = await roomWithMembers(['阿甲']);
    const a = members[0]!;
    const trackId = await uploadTrack(code, a.cookie, 'a.mp3');

    a.ws.send(JSON.stringify({ type: 'play', trackId }));
    await nextOfType(a.next, 'playback');

    a.ws.send(JSON.stringify({ type: 'seek', positionMs: 42_000 }));
    await nextOfType(a.next, 'playback');

    a.ws.send(JSON.stringify({ type: 'pause' }));
    const paused = await nextOfType(a.next, 'playback');
    expect(paused.playback.isPlaying).toBe(false);
    // 暂停会把「此刻推算出的位置」固化下来，所以会比 seek 目标多出几毫秒 —— 这是对的
    expect(paused.playback.positionMs).toBeGreaterThanOrEqual(42_000);
    expect(paused.playback.positionMs).toBeLessThan(42_500);

    const frozenAt = paused.playback.positionMs;

    a.ws.send(JSON.stringify({ type: 'resume' }));
    const resumed = await nextOfType(a.next, 'playback');
    expect(resumed.playback.isPlaying).toBe(true);
    // 关键：从冻结处继续，而不是回到 0
    expect(resumed.playback.positionMs).toBe(frozenAt);
  });

  it('seek 跳到目标位置', async () => {
    const { code, members } = await roomWithMembers(['阿甲']);
    const a = members[0]!;
    const trackId = await uploadTrack(code, a.cookie, 'a.mp3');

    a.ws.send(JSON.stringify({ type: 'play', trackId }));
    await nextOfType(a.next, 'playback');
    a.ws.send(JSON.stringify({ type: 'seek', positionMs: 90_000 }));

    const frame = await nextOfType(a.next, 'playback');
    expect(frame.playback.positionMs).toBe(90_000);
  });

  it('seek 负数归零，且不改变播放状态', async () => {
    const { code, members } = await roomWithMembers(['阿甲']);
    const a = members[0]!;
    const trackId = await uploadTrack(code, a.cookie, 'a.mp3');

    a.ws.send(JSON.stringify({ type: 'play', trackId }));
    await nextOfType(a.next, 'playback');
    a.ws.send(JSON.stringify({ type: 'seek', positionMs: -10 }));

    const frame = await nextOfType(a.next, 'playback');
    expect(frame.playback.positionMs).toBe(0);
    expect(frame.playback.isPlaying).toBe(true);
  });

  it('seq 单调递增，客户端据此丢弃乱序帧', async () => {
    const { code, members } = await roomWithMembers(['阿甲']);
    const a = members[0]!;
    const trackId = await uploadTrack(code, a.cookie, 'a.mp3');

    const seqs: number[] = [];
    a.ws.send(JSON.stringify({ type: 'play', trackId }));
    seqs.push((await nextOfType(a.next, 'playback')).playback.seq);
    a.ws.send(JSON.stringify({ type: 'pause' }));
    seqs.push((await nextOfType(a.next, 'playback')).playback.seq);
    a.ws.send(JSON.stringify({ type: 'seek', positionMs: 1000 }));
    seqs.push((await nextOfType(a.next, 'playback')).playback.seq);

    for (let i = 1; i < seqs.length; i++) expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);
  });

  it('没有曲目时 pause / resume / seek 都不产生广播', async () => {
    const { code, members } = await roomWithMembers(['阿甲']);
    const a = members[0]!;

    a.ws.send(JSON.stringify({ type: 'pause' }));
    a.ws.send(JSON.stringify({ type: 'resume' }));
    a.ws.send(JSON.stringify({ type: 'seek', positionMs: 5000 }));

    // 紧接着放一首：如果前面三个产生了广播，这里读到的第一帧就不是 play 的结果
    const trackId = await uploadTrack(code, a.cookie, 'a.mp3');
    a.ws.send(JSON.stringify({ type: 'play', trackId }));

    const frame = await nextOfType(a.next, 'playback');
    expect(frame.playback.trackId).toBe(trackId);
    expect(frame.playback.positionMs).toBe(0);
  });

  it('播放不存在的曲目被忽略', async () => {
    const { code, members } = await roomWithMembers(['阿甲']);
    const a = members[0]!;
    const trackId = await uploadTrack(code, a.cookie, 'a.mp3');

    a.ws.send(JSON.stringify({ type: 'play', trackId: '00000000-0000-0000-0000-000000000000' }));
    a.ws.send(JSON.stringify({ type: 'play', trackId }));

    const frame = await nextOfType(a.next, 'playback');
    expect(frame.playback.trackId).toBe(trackId);
  });

  it('畸形与未知消息被忽略，不影响后续正常消息', async () => {
    const { code, members } = await roomWithMembers(['阿甲']);
    const a = members[0]!;
    const trackId = await uploadTrack(code, a.cookie, 'a.mp3');

    a.ws.send('not json at all');
    a.ws.send(JSON.stringify({ type: 'nonsense' }));
    a.ws.send(JSON.stringify({ type: 'play' })); // 缺 trackId
    a.ws.send(JSON.stringify({ type: 'seek', positionMs: 'abc' })); // 类型不对
    a.ws.send(JSON.stringify({ type: 'play', trackId }));

    const frame = await nextOfType(a.next, 'playback');
    expect(frame.playback.trackId).toBe(trackId);
  });

  it('暂停之后 alarm 被取消，没有周期性消息', async () => {
    const { code, members } = await roomWithMembers(['阿甲']);
    const a = members[0]!;
    const trackId = await uploadTrack(code, a.cookie, 'a.mp3');

    a.ws.send(JSON.stringify({ type: 'play', trackId }));
    await nextOfType(a.next, 'playback');
    a.ws.send(JSON.stringify({ type: 'pause' }));
    await nextOfType(a.next, 'playback');

    // 暂停状态下只应存在「聊天」这类被动消息；主动读一帧应当超时
    const raced = await Promise.race([
      a.next().then(() => 'got-something'),
      new Promise((r) => setTimeout(() => r('quiet'), 300)),
    ]);
    expect(raced).toBe('quiet');
  });

  it('next 切到队列里的下一首，prev 切回上一首', async () => {
    const { code, members } = await roomWithMembers(['阿甲']);
    const a = members[0]!;
    const one = await uploadTrack(code, a.cookie, 'one.mp3');
    const two = await uploadTrack(code, a.cookie, 'two.mp3');

    a.ws.send(JSON.stringify({ type: 'play', trackId: one }));
    await nextOfType(a.next, 'playback');

    a.ws.send(JSON.stringify({ type: 'next' }));
    const second = await nextOfType(a.next, 'playback');
    expect(second.playback.trackId).toBe(two);
    expect(second.playback.positionMs).toBe(0);

    a.ws.send(JSON.stringify({ type: 'prev' }));
    const back = await nextOfType(a.next, 'playback');
    expect(back.playback.trackId).toBe(one);
  });

  it('在最后一首按 next：停在末尾并暂停，不回绕到第一首', async () => {
    const { code, members } = await roomWithMembers(['阿甲']);
    const a = members[0]!;
    const one = await uploadTrack(code, a.cookie, 'one.mp3');
    await uploadTrack(code, a.cookie, 'two.mp3');

    a.ws.send(JSON.stringify({ type: 'play', trackId: one }));
    await nextOfType(a.next, 'playback');
    a.ws.send(JSON.stringify({ type: 'next' }));
    await nextOfType(a.next, 'playback');
    a.ws.send(JSON.stringify({ type: 'next' }));

    const stopped = await nextOfType(a.next, 'playback');
    expect(stopped.playback.isPlaying).toBe(false);
    expect(stopped.playback.trackId).not.toBe(one);
  });

  it('第一个人按了播放，第二个人刷新后拿到的快照里带着这个状态', async () => {
    const { code, members } = await roomWithMembers(['阿甲', '阿乙']);
    const a = members[0]!;
    const trackId = await uploadTrack(code, a.cookie, 'a.mp3');

    a.ws.send(JSON.stringify({ type: 'play', trackId }));
    await nextOfType(a.next, 'playback');

    const late = await member(code, '丙');
    const state = await nextOfType(late.next, 'state');
    expect(state.room.playback.trackId).toBe(trackId);
    expect(state.room.playback.isPlaying).toBe(true);
  });

  it('快照帧必须带 serverNow，否则新人要干等到下一次周期同步帧才有声音', async () => {
    const { code, members } = await roomWithMembers(['阿甲']);
    const a = members[0]!;
    const trackId = await uploadTrack(code, a.cookie, 'a.mp3');

    a.ws.send(JSON.stringify({ type: 'play', trackId }));
    await nextOfType(a.next, 'playback');

    const before = Date.now();
    const late = await member(code, '乙');
    const state = await nextOfType(late.next, 'state');
    const after = Date.now();

    expect(typeof state.serverNow).toBe('number');
    // 服务端时刻应当落在请求前后的这段真实时间里
    expect(state.serverNow).toBeGreaterThanOrEqual(before - 1000);
    expect(state.serverNow).toBeLessThanOrEqual(after + 1000);
  });
});
