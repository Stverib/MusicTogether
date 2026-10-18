import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { DEFAULT_THEME } from '../../src/shared/themes';
import { member, newRoom, nextOfType, roomWithMembers, stateOf } from './helpers';

/** 把一份人造的持久化状态写回房间，用来覆盖"升级前的房间"那条分支 */
async function overwriteStoredRoom(code: string, mutate: (room: any) => void): Promise<void> {
  const stub = (env as any).ROOMS.get((env as any).ROOMS.idFromName(code));
  const room = await (await stub.fetch('https://do/state')).json();
  mutate(room);
  const res = await stub.fetch('https://do/__test_write_state', {
    method: 'POST',
    body: JSON.stringify(room),
  });
  if (!res.ok) throw new Error(`seed failed: ${res.status}`);
}

describe('房间级主题', () => {
  it('新房间的默认主题是 DEFAULT_THEME', async () => {
    const code = await newRoom();
    const m = await member(code, '阿甲');
    const state = await nextOfType(m.next, 'state');
    expect(state.room.theme).toBe(DEFAULT_THEME);
  });

  it('HTTP 的 /state 快照里也带着主题', async () => {
    const code = await newRoom();
    const m = await member(code, '阿甲');
    expect((await stateOf(code, m.cookie)).theme).toBe(DEFAULT_THEME);
  });

  it('发非法主题时房间状态不变', async () => {
    const { code, members } = await roomWithMembers(['阿甲']);
    const a = members[0]!;

    a.ws.send(JSON.stringify({ type: 'theme', theme: 'starfield' }));
    a.ws.send(JSON.stringify({ type: 'theme', theme: 123 }));
    a.ws.send(JSON.stringify({ type: 'theme' }));

    // 后面还排着一条合法的聊天，用它当"前面那几条都处理完了"的信号
    a.ws.send(JSON.stringify({ type: 'chat', text: '栅栏' }));
    await nextOfType(a.next, 'chat');

    expect((await stateOf(code, a.cookie)).theme).toBe(DEFAULT_THEME);
  });

  it('设成同一个主题是幂等的，不产生广播', async () => {
    const { members } = await roomWithMembers(['阿甲']);
    const a = members[0]!;

    a.ws.send(JSON.stringify({ type: 'theme', theme: DEFAULT_THEME }));
    a.ws.send(JSON.stringify({ type: 'chat', text: '栅栏' }));

    // 队列里第一条就该是那条聊天 —— 中间没有 theme 帧插进来
    const frame = await nextOfType(a.next, 'chat');
    expect(frame.text).toBe('栅栏');
  });

  it('升级前建的房间（持久化状态里没有 theme）load 出来是默认主题', async () => {
    const code = await newRoom();
    const m = await member(code, '阿甲');
    await nextOfType(m.next, 'state');

    // 抹掉 theme，模拟升级前存下的那份状态
    await overwriteStoredRoom(code, (room) => {
      delete room.theme;
    });

    // 再读一次会重新唤醒 DO，走的就是构造函数里的迁移分支
    expect((await stateOf(code, m.cookie)).theme).toBe(DEFAULT_THEME);
  });

  it('被塞进垃圾 theme 的房间也能救回来', async () => {
    const code = await newRoom();
    const m = await member(code, '阿甲');
    await nextOfType(m.next, 'state');

    await overwriteStoredRoom(code, (room) => {
      room.theme = 'starfield';
    });

    expect((await stateOf(code, m.cookie)).theme).toBe(DEFAULT_THEME);
  });

  it('重连之后的快照里仍然带着主题', async () => {
    const code = await newRoom();
    const first = await member(code, '阿甲');
    await nextOfType(first.next, 'state');

    const again = await member(code, '阿甲', { clientId: first.clientId });
    const state = await nextOfType(again.next, 'state');
    expect(state.room.theme).toBe(DEFAULT_THEME);
  });
});
