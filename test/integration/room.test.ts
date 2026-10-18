import { describe, it, expect } from 'vitest';
import { SELF } from 'cloudflare:test';
import {
  ORIGIN,
  joinRoom,
  member,
  newRoom,
  nextIp,
  nextOfType,
  openWs,
  roomWithMembers,
} from './helpers';

/** 默认 sort() 按 UTF-16 码位排，中文顺序不是人预期的 —— 两边用同一个排序再比 */
const sorted = (names: string[]) => [...names].sort();

describe('房间连接与成员', () => {
  it('新连上的人立刻收到完整状态快照', async () => {
    const code = await newRoom();
    const m = await member(code, '阿甲');

    const state = await nextOfType(m.next, 'state');
    expect(state.room.code).toBe(code);
    expect(state.room.members).toHaveLength(1);
    expect(state.room.members[0].name).toBe('阿甲');
    expect(state.room.queue).toEqual([]);
    expect(state.room.tracks).toEqual([]);
    expect(state.room.playback.trackId).toBeNull();
  });

  it('第二个人进来时，先到的人收到成员变化广播', async () => {
    const { members } = await roomWithMembers(['阿甲', '阿乙']);
    const broadcast = await nextOfType(members[0]!.next, 'members');
    expect(sorted(broadcast.members.map((m: any) => m.name))).toEqual(sorted(['阿甲', '阿乙']));
  });

  it('后进来的人，快照里就已经包含先到的人', async () => {
    const code = await newRoom();
    await member(code, '阿甲');
    const b = await member(code, '阿乙');

    const state = await nextOfType(b.next, 'state');
    expect(sorted(state.room.members.map((m: any) => m.name))).toEqual(sorted(['阿甲', '阿乙']));
  });

  it('同一个 clientId 重连不会变成第二个成员，且名字会更新', async () => {
    const code = await newRoom();
    const first = await joinRoom(code, '阿甲');
    expect(first.status).toBe(200);

    const conn1 = await openWs(code, first.cookie);
    await nextOfType(conn1.next, 'state');

    const again = await joinRoom(code, '阿甲改名了', { clientId: first.clientId });
    expect(again.status).toBe(200);
    expect(again.clientId).toBe(first.clientId);

    const conn2 = await openWs(code, again.cookie);
    const state = await nextOfType(conn2.next, 'state');

    // 同一个 clientId 换了个连接进来，成员数不变，名字更新
    expect(state.room.members).toHaveLength(1);
    expect(state.room.members[0].name).toBe('阿甲改名了');
  });

  it('有人断线后成员列表移除他，并广播给剩下的人', async () => {
    const { members } = await roomWithMembers(['阿甲', '阿乙']);
    const a = members[0]!;
    const b = members[1]!;

    b.ws.close(1000, 'bye');

    // 阿甲的队列里先是「阿乙进来」（2 人），再是「阿乙离开」（1 人）
    let latest: any = null;
    for (let i = 0; i < 4; i++) {
      latest = await nextOfType(a.next, 'members');
      if (latest.members.length === 1) break;
    }
    expect(latest.members).toHaveLength(1);
    expect(latest.members[0].name).toBe('阿甲');
  });

  it('三个人可以同时在同一个房间', async () => {
    const { code, members } = await roomWithMembers(['甲', '乙', '丙']);

    const state = (await (
      await SELF.fetch(`${ORIGIN}/api/rooms/${code}/state`, {
        headers: { Cookie: members[0]!.cookie, 'CF-Connecting-IP': nextIp() },
      })
    ).json()) as any;

    expect(members).toHaveLength(3);
    expect(sorted(state.members.map((m: any) => m.name))).toEqual(sorted(['甲', '乙', '丙']));
  });

  it('非成员无法连接 WebSocket', async () => {
    const target = await newRoom();
    const other = await newRoom();
    const outsider = await joinRoom(other, '陌生人');

    const res = await SELF.fetch(`${ORIGIN}/api/rooms/${target}/ws`, {
      headers: {
        Upgrade: 'websocket',
        Cookie: outsider.cookie,
        Origin: ORIGIN,
        'CF-Connecting-IP': nextIp(),
      },
    });
    expect(res.status).toBe(401);
  });

  it('房间不存在时加入返回 404', async () => {
    const res = await joinRoom('ZZZZZZ', '阿甲');
    expect(res.status).toBe(404);
  });

  it('快照里队列与曲目表初始为空，epoch 是数字', async () => {
    const code = await newRoom();
    const m = await member(code, '阿甲');
    const state = await nextOfType(m.next, 'state');
    expect(typeof state.room.epoch).toBe('number');
    expect(state.room.queue).toEqual([]);
    expect(state.room.tracks).toEqual([]);
  });
});
