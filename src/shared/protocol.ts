import type { Member, Playback, RoomState, Track } from './types';

/**
 * 心跳必须逐字节精确匹配，才能被 Durable Object 的
 * setWebSocketAutoResponse 直接应答而不唤醒房间。
 */
export const PING = '{"type":"ping"}';
export const PONG = '{"type":"pong"}';

export type ClientMessage =
  | { type: 'hello'; name: string }
  | { type: 'play'; trackId: string }
  | { type: 'resume' }
  | { type: 'pause' }
  | { type: 'seek'; positionMs: number }
  | { type: 'next' }
  | { type: 'prev' }
  | { type: 'enqueue'; trackId: string }
  | { type: 'dequeue'; trackId: string }
  | { type: 'reorder'; queue: string[] }
  | { type: 'chat'; text: string };

export type ServerMessage =
  /**
   * 连接（含重连）后的全量快照。
   *
   * 必须带 serverNow：客户端要靠它把锚点换算成"现在应该播到哪儿"，
   * 否则新人进房只能干等到下一次周期性同步帧（最多 30 秒）才有声音。
   */
  | { type: 'state'; room: RoomState; serverNow: number }
  | { type: 'playback'; playback: Playback; serverNow: number }
  | { type: 'sync'; playback: Playback; serverNow: number }
  | { type: 'queue'; queue: string[]; epoch: number }
  | { type: 'tracks'; tracks: Track[]; epoch: number }
  | { type: 'members'; members: Member[] }
  | { type: 'chat'; from: string; name: string; text: string; at: number }
  | { type: 'error'; message: string };

export const CHAT_MAX_LENGTH = 500;

export function parseClientMessage(raw: string): ClientMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const type = (value as { type?: unknown }).type;
  return typeof type === 'string' ? (value as ClientMessage) : null;
}
