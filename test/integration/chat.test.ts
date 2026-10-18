import { describe, it, expect } from 'vitest';
import { member, nextOfType, roomWithMembers, stateOf } from './helpers';

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

  it('聊天不落库：房间快照里没有任何历史消息字段', async () => {
    const { code, members } = await roomWithMembers(['阿甲']);
    const a = members[0]!;

    a.ws.send(JSON.stringify({ type: 'chat', text: '老消息' }));
    await nextOfType(a.next, 'chat');

    const state = await stateOf(code, a.cookie);
    expect(state).not.toHaveProperty('messages');
    expect(state).not.toHaveProperty('chat');
  });

  it('后来的人看不到之前发过的消息', async () => {
    const { code, members } = await roomWithMembers(['阿甲']);
    const a = members[0]!;

    a.ws.send(JSON.stringify({ type: 'chat', text: '老消息' }));
    await nextOfType(a.next, 'chat');

    const late = await member(code, '丙');
    const state = await nextOfType(late.next, 'state');
    expect(JSON.stringify(state)).not.toContain('老消息');
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
