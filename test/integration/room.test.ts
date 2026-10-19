import { describe, it, expect } from 'vitest';
import {
  ORIGIN,
  SELF,
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

  it('新连上的人默认是在线且在场', async () => {
    const code = await newRoom();
    const m = await member(code, '阿甲');
    const state = await nextOfType(m.next, 'state');
    expect(state.room.members[0].online).toBe(true);
    expect(state.room.members[0].away).toBe(false);
  });

  it('页面不可见时标记为离开，回来又翻回在线', async () => {
    const { members } = await roomWithMembers(['阿甲', '阿乙']);
    const a = members[0]!;
    const b = members[1]!;

    a.ws.send(JSON.stringify({ type: 'presence', away: true }));

    let latest: any = null;
    for (let i = 0; i < 4; i++) {
      latest = await nextOfType(b.next, 'members');
      const jia = latest.members.find((m: any) => m.name === '阿甲');
      if (jia && jia.away === true) break;
    }
    expect(latest.members.find((m: any) => m.name === '阿甲').away).toBe(true);
    // 只是离开了页面，连接还在 —— online 不该被动
    expect(latest.members.find((m: any) => m.name === '阿甲').online).toBe(true);

    a.ws.send(JSON.stringify({ type: 'presence', away: false }));

    for (let i = 0; i < 4; i++) {
      latest = await nextOfType(b.next, 'members');
      const jia = latest.members.find((m: any) => m.name === '阿甲');
      if (jia && jia.away === false) break;
    }
    expect(latest.members.find((m: any) => m.name === '阿甲').away).toBe(false);
  });

  it('重复上报同一个状态是幂等的，不产生广播', async () => {
    const { members } = await roomWithMembers(['阿甲', '阿乙']);
    const a = members[0]!;
    const b = members[1]!;

    // 已经在场，再报一次在场不该有任何广播。后面排一条聊天当栅栏 ——
    // 若中间插了 members 帧，这里读到的第一条就不是它
    a.ws.send(JSON.stringify({ type: 'presence', away: false }));
    a.ws.send(JSON.stringify({ type: 'chat', text: '栅栏' }));
    expect((await nextOfType(b.next, 'chat')).text).toBe('栅栏');
  });

  it('离开页面的人重连后翻回在线', async () => {
    const { code, members } = await roomWithMembers(['阿甲', '阿乙']);
    const a = members[0]!;
    const b = members[1]!;

    b.ws.send(JSON.stringify({ type: 'presence', away: true }));
    let latest: any = null;
    for (let i = 0; i < 4; i++) {
      latest = await nextOfType(a.next, 'members');
      const yi = latest.members.find((m: any) => m.name === '阿乙');
      if (yi && yi.away === true) break;
    }
    expect(latest.members.find((m: any) => m.name === '阿乙').away).toBe(true);

    // 重连意味着页面又看得见了 —— 不翻回来的话，人会永远停在"已离开"
    const again = await member(code, '阿乙', { clientId: b.clientId });
    const state = await nextOfType(again.next, 'state');
    expect(state.room.members.find((m: any) => m.name === '阿乙').away).toBe(false);
  });

  it('发非法 presence 载荷时房间状态不变', async () => {
    const { code, members } = await roomWithMembers(['阿甲']);
    const a = members[0]!;

    a.ws.send(JSON.stringify({ type: 'presence' }));
    a.ws.send(JSON.stringify({ type: 'presence', away: 'yes' }));
    a.ws.send(JSON.stringify({ type: 'presence', away: 1 }));
    // 栅栏
    a.ws.send(JSON.stringify({ type: 'chat', text: '栅栏' }));
    await nextOfType(a.next, 'chat');

    const state = await SELF.fetch(`${ORIGIN}/api/rooms/${code}/state`, {
      headers: { Cookie: a.cookie, 'CF-Connecting-IP': nextIp() },
    });
    expect(((await state.json()) as any).members[0].away).toBe(false);
  });

  it('有人断线后留在成员列表里，但标记为已离开', async () => {
    const { members } = await roomWithMembers(['阿甲', '阿乙']);
    const a = members[0]!;
    const b = members[1]!;

    b.ws.close(1000, 'bye');

    // 阿甲的队列里先是「阿乙进来」（2 人），再是「阿乙离线」（仍是 2 人）。
    // 断线不再把人从列表里删掉 —— 删掉的话"已离开"这个状态根本不存在。
    let latest: any = null;
    for (let i = 0; i < 4; i++) {
      latest = await nextOfType(a.next, 'members');
      const yi = latest.members.find((m: any) => m.name === '阿乙');
      if (yi && yi.online === false) break;
    }
    expect(latest.members).toHaveLength(2);
    expect(latest.members.find((m: any) => m.name === '阿乙').online).toBe(false);
    expect(latest.members.find((m: any) => m.name === '阿甲').online).toBe(true);
  });

  it('断线的人重连后翻回在线，不会变成第二个成员', async () => {
    const { code, members } = await roomWithMembers(['阿甲', '阿乙']);
    const a = members[0]!;
    const b = members[1]!;

    // 必须留一个人在场上读广播 —— 关掉的是阿乙自己的连接，
    // 从它那儿是永远读不到"阿乙离线"这条广播的
    b.ws.close(1000, 'bye');
    let latest: any = null;
    for (let i = 0; i < 4; i++) {
      latest = await nextOfType(a.next, 'members');
      const yi = latest.members.find((m: any) => m.name === '阿乙');
      if (yi && yi.online === false) break;
    }
    expect(latest.members.find((m: any) => m.name === '阿乙').online).toBe(false);

    // 同一个人拿同一个 clientId 重新连上：不新增成员，只是翻回在线
    const again = await member(code, '阿乙', { clientId: b.clientId });
    const state = await nextOfType(again.next, 'state');
    expect(state.room.members).toHaveLength(2);
    expect(state.room.members.find((m: any) => m.name === '阿乙').online).toBe(true);
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
