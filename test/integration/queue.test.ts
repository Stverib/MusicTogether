import { describe, it, expect } from 'vitest';
import { nextOfType, roomWithMembers, stateOf, uploadTrack, waitForQueue } from './helpers';

describe('队列', () => {
  it('上传的歌自动进入队列，按上传顺序排列', async () => {
    const { code, members } = await roomWithMembers(['阿甲']);
    const a = members[0]!;

    const one = await uploadTrack(code, a.cookie, 'A.mp3');
    const two = await uploadTrack(code, a.cookie, 'B.mp3');
    const three = await uploadTrack(code, a.cookie, 'C.mp3');

    expect((await stateOf(code, a.cookie)).queue).toEqual([one, two, three]);
  });

  it('上传时广播 queue 帧，别人能实时看到', async () => {
    const { code, members } = await roomWithMembers(['阿甲', '阿乙']);
    const [a, b] = members as [typeof members[0], typeof members[0]];

    const trackId = await uploadTrack(code, a.cookie, 'A.mp3');

    const frame = await waitForQueue(b.next, [trackId]);
    expect(typeof frame.epoch).toBe('number');
  });

  it('dequeue 从队列移除，但曲目仍在云端（这是"移除"与"删除"的区别）', async () => {
    const { code, members } = await roomWithMembers(['阿甲']);
    const a = members[0]!;

    const one = await uploadTrack(code, a.cookie, 'A.mp3');
    const two = await uploadTrack(code, a.cookie, 'B.mp3');

    a.ws.send(JSON.stringify({ type: 'dequeue', trackId: one }));
    await waitForQueue(a.next, [two]);

    const state = await stateOf(code, a.cookie);
    expect(state.tracks).toHaveLength(2); // 曲目还在
    expect(state.queue).toEqual([two]); // 只是不在队列里
  });

  it('dequeue 掉正在播的那首会重置播放状态', async () => {
    const { code, members } = await roomWithMembers(['阿甲']);
    const a = members[0]!;
    const trackId = await uploadTrack(code, a.cookie, 'A.mp3');

    a.ws.send(JSON.stringify({ type: 'play', trackId }));
    await nextOfType(a.next, 'playback');

    a.ws.send(JSON.stringify({ type: 'dequeue', trackId }));
    const pb = await nextOfType(a.next, 'playback');
    expect(pb.playback.trackId).toBeNull();
    expect(pb.playback.isPlaying).toBe(false);

    expect((await stateOf(code, a.cookie)).playback.trackId).toBeNull();
  });

  it('enqueue 把已移除的歌放回队尾', async () => {
    const { code, members } = await roomWithMembers(['阿甲']);
    const a = members[0]!;

    const one = await uploadTrack(code, a.cookie, 'A.mp3');
    const two = await uploadTrack(code, a.cookie, 'B.mp3');

    a.ws.send(JSON.stringify({ type: 'dequeue', trackId: one }));
    await waitForQueue(a.next, [two]);

    a.ws.send(JSON.stringify({ type: 'enqueue', trackId: one }));
    await waitForQueue(a.next, [two, one]);
  });

  it('enqueue 一首已在队列里的歌不会产生重复', async () => {
    const { code, members } = await roomWithMembers(['阿甲']);
    const a = members[0]!;

    const one = await uploadTrack(code, a.cookie, 'A.mp3');
    const two = await uploadTrack(code, a.cookie, 'B.mp3');

    // 应被忽略
    a.ws.send(JSON.stringify({ type: 'enqueue', trackId: one }));
    // 合法操作，作为同步点
    a.ws.send(JSON.stringify({ type: 'reorder', queue: [two, one] }));
    await waitForQueue(a.next, [two, one]);

    expect((await stateOf(code, a.cookie)).queue).toEqual([two, one]);
  });

  it('reorder 改变顺序并广播', async () => {
    const { code, members } = await roomWithMembers(['阿甲']);
    const a = members[0]!;

    const one = await uploadTrack(code, a.cookie, 'A.mp3');
    const two = await uploadTrack(code, a.cookie, 'B.mp3');
    const three = await uploadTrack(code, a.cookie, 'C.mp3');

    a.ws.send(JSON.stringify({ type: 'reorder', queue: [three, two, one] }));
    await waitForQueue(a.next, [three, two, one]);

    expect((await stateOf(code, a.cookie)).queue).toEqual([three, two, one]);
  });

  it('reorder 传入未知 id、漏掉 id、重复 id 或错误类型时被忽略', async () => {
    const { code, members } = await roomWithMembers(['阿甲']);
    const a = members[0]!;

    const one = await uploadTrack(code, a.cookie, 'A.mp3');
    const two = await uploadTrack(code, a.cookie, 'B.mp3');

    a.ws.send(JSON.stringify({ type: 'reorder', queue: [one, 'ghost'] })); // 未知 id
    a.ws.send(JSON.stringify({ type: 'reorder', queue: [one] })); // 漏了一个
    a.ws.send(JSON.stringify({ type: 'reorder', queue: [one, one] })); // 重复
    a.ws.send(JSON.stringify({ type: 'reorder', queue: 'nope' })); // 类型不对
    a.ws.send(JSON.stringify({ type: 'reorder', queue: [two, one] })); // 这个合法

    await waitForQueue(a.next, [two, one]);
    expect((await stateOf(code, a.cookie)).queue).toEqual([two, one]);
  });

  it('reorder 之后播放不受影响，还在原来那首上', async () => {
    const { code, members } = await roomWithMembers(['阿甲']);
    const a = members[0]!;

    const one = await uploadTrack(code, a.cookie, 'A.mp3');
    const two = await uploadTrack(code, a.cookie, 'B.mp3');

    a.ws.send(JSON.stringify({ type: 'play', trackId: one }));
    await nextOfType(a.next, 'playback');

    a.ws.send(JSON.stringify({ type: 'reorder', queue: [two, one] }));
    await waitForQueue(a.next, [two, one]);

    const state = await stateOf(code, a.cookie);
    expect(state.playback.trackId).toBe(one);
    expect(state.playback.isPlaying).toBe(true);
  });

  it('epoch 随队列结构变化单调递增', async () => {
    const { code, members } = await roomWithMembers(['阿甲']);
    const a = members[0]!;

    const before = (await stateOf(code, a.cookie)).epoch;
    await uploadTrack(code, a.cookie, 'A.mp3');
    const afterUpload = (await stateOf(code, a.cookie)).epoch;

    expect(afterUpload).toBeGreaterThan(before);
  });

  it('B 也能改队列（平权）', async () => {
    const { code, members } = await roomWithMembers(['阿甲', '阿乙']);
    const [a, b] = members as [typeof members[0], typeof members[0]];

    const one = await uploadTrack(code, a.cookie, 'A.mp3');
    const two = await uploadTrack(code, a.cookie, 'B.mp3');

    // 阿乙发起变更，阿甲应当收到广播
    b.ws.send(JSON.stringify({ type: 'reorder', queue: [two, one] }));
    await waitForQueue(a.next, [two, one]);
  });
});
