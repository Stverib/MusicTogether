import { describe, it, expect } from 'vitest';
import { ORIGIN, SELF, chatOf, member, nextIp, nextOfType, roomWithMembers, stateOf } from './helpers';

describe('聊天', () => {
  it('消息广播给房间里所有人，含发送者', async () => {
    const { members } = await roomWithMembers(['阿甲', '阿乙']);
    const [a, b] = members as [typeof members[0], typeof members[0]];

    a.ws.send(JSON.stringify({ type: 'chat', text: '这首歌好听' }));

    for (const who of [a, b]) {
      const frame = await nextOfType(who.next, 'chat');
      expect(frame.text).toBe('这首歌好听');
      expect(frame.name).toBe('阿甲');
      expect(typeof frame.at).toBe('number');
      expect(typeof frame.from).toBe('string');
    }
  });

  it('空消息、纯空白与超长消息被丢弃', async () => {
    const { members } = await roomWithMembers(['阿甲']);
    const a = members[0]!;

    a.ws.send(JSON.stringify({ type: 'chat', text: '' }));
    a.ws.send(JSON.stringify({ type: 'chat', text: '   ' }));
    a.ws.send(JSON.stringify({ type: 'chat', text: 'x'.repeat(501) }));
    a.ws.send(JSON.stringify({ type: 'chat', text: '正常' }));

    const frame = await nextOfType(a.next, 'chat');
    expect(frame.text).toBe('正常');
  });

  it('恰好 500 字的消息可以发出（边界）', async () => {
    const { members } = await roomWithMembers(['阿甲']);
    const a = members[0]!;
    const text = 'x'.repeat(500);

    a.ws.send(JSON.stringify({ type: 'chat', text }));
    const frame = await nextOfType(a.next, 'chat');
    expect(frame.text).toHaveLength(500);
  });

  it('消息里的 HTML 原样传回，转义是前端的责任', async () => {
    const { members } = await roomWithMembers(['阿甲']);
    const a = members[0]!;
    const payload = '<img src=x onerror=alert(1)>';

    a.ws.send(JSON.stringify({ type: 'chat', text: payload }));
    const frame = await nextOfType(a.next, 'chat');

    // 服务端不做转义 —— 在输入端转义会导致双重转义，而且骗不过其他输出渠道
    expect(frame.text).toBe(payload);
  });

  it('消息前后空白会被裁掉', async () => {
    const { members } = await roomWithMembers(['阿甲']);
    const a = members[0]!;

    a.ws.send(JSON.stringify({ type: 'chat', text: '  你好  ' }));
    const frame = await nextOfType(a.next, 'chat');
    expect(frame.text).toBe('你好');
  });

  it('聊天落库：后来的人在快照里就能看到历史', async () => {
    const { code, members } = await roomWithMembers(['阿甲']);
    const a = members[0]!;

    a.ws.send(JSON.stringify({ type: 'chat', text: '老消息' }));
    await nextOfType(a.next, 'chat');

    const late = await member(code, '丙');
    const state = await nextOfType(late.next, 'state');
    expect(state.chat.map((m: any) => m.text)).toEqual(['老消息']);
    expect(state.chat[0].name).toBe('阿甲');
    expect(state.chat[0].id).toBe(1);
    expect(state.chatTotal).toBe(1);
  });

  it('重连之后历史还在 —— 是落库，不是只留在内存里', async () => {
    const { code, members } = await roomWithMembers(['阿甲']);
    const a = members[0]!;
    a.ws.send(JSON.stringify({ type: 'chat', text: '第一条' }));
    await nextOfType(a.next, 'chat');

    const again = await member(code, '阿甲', { clientId: a.clientId });
    const state = await nextOfType(again.next, 'state');
    expect(state.chat.map((m: any) => m.text)).toEqual(['第一条']);
  });

  it('消息 id 在一个房间里单调递增', async () => {
    const { members } = await roomWithMembers(['阿甲']);
    const a = members[0]!;
    for (const t of ['一', '二', '三']) a.ws.send(JSON.stringify({ type: 'chat', text: t }));

    const ids: number[] = [];
    for (let i = 0; i < 3; i++) ids.push((await nextOfType(a.next, 'chat')).id);
    expect(ids).toEqual([1, 2, 3]);
  });

  it('聊天不进 RoomState —— 它有自己的存储键，不跟着播放状态一起重写', async () => {
    const { code, members } = await roomWithMembers(['阿甲']);
    const a = members[0]!;
    a.ws.send(JSON.stringify({ type: 'chat', text: '一条' }));
    await nextOfType(a.next, 'chat');

    const state = await stateOf(code, a.cookie);
    expect(state).not.toHaveProperty('chat');
    expect(state).not.toHaveProperty('messages');
  });

  it('HTTP 的 /chat?before= 按游标取更早的消息', async () => {
    const { code, members } = await roomWithMembers(['阿甲']);
    const a = members[0]!;
    for (const t of ['一', '二', '三']) a.ws.send(JSON.stringify({ type: 'chat', text: t }));
    for (let i = 0; i < 3; i++) await nextOfType(a.next, 'chat');

    // 不带游标 = 最新一页
    expect((await chatOf(code, a.cookie)).map((m: any) => m.text)).toEqual(['一', '二', '三']);
    // before=3 = 取 id < 3 的那两条
    expect((await chatOf(code, a.cookie, 3)).map((m: any) => m.text)).toEqual(['一', '二']);
    // 游标不合法时安静地退回最新一页，而不是 500
    expect((await chatOf(code, a.cookie, 'abc')).map((m: any) => m.text)).toEqual(['一', '二', '三']);
  });

  it('没有会话就读不到聊天历史', async () => {
    const { code } = await roomWithMembers(['阿甲']);
    const res = await SELF.fetch(`${ORIGIN}/api/rooms/${code}/chat`, {
      headers: { 'CF-Connecting-IP': nextIp() },
    });
    expect(res.status).toBe(401);
  });

  it('没有 text 字段的消息被忽略', async () => {
    const { members } = await roomWithMembers(['阿甲']);
    const a = members[0]!;

    a.ws.send(JSON.stringify({ type: 'chat' }));
    a.ws.send(JSON.stringify({ type: 'chat', text: 123 }));
    a.ws.send(JSON.stringify({ type: 'chat', text: '好' }));

    const frame = await nextOfType(a.next, 'chat');
    expect(frame.text).toBe('好');
  });
});
