import { computed, signal } from '@preact/signals';
import type { Playback, RoomState, Track } from '../shared/types';
import { connect, type ConnStatus } from './ws';

const LS_CLIENT_ID = 'mt_client_id';
const LS_ROOM = 'mt_room';
const LS_NAME = 'mt_name';

export type ChatMessage = { from: string; name: string; text: string; at: number };

/** 身份存在这台设备的浏览器里。没有账号系统，这就是全部的身份。 */
export function getOrCreateClientId(): string {
  let id = localStorage.getItem(LS_CLIENT_ID);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(LS_CLIENT_ID, id);
  }
  return id;
}

export const savedRoom = (): string | null => localStorage.getItem(LS_ROOM);
export const savedName = (): string => localStorage.getItem(LS_NAME) ?? '';

class RoomStore {
  readonly room = signal<RoomState | null>(null);
  readonly status = signal<ConnStatus>('closed');
  readonly error = signal<string | null>(null);
  readonly chat = signal<ChatMessage[]>([]);
  readonly myName = signal<string>(savedName());

  private conn: ReturnType<typeof connect> | null = null;

  readonly currentTrack = computed<Track | null>(() => {
    const r = this.room.value;
    if (!r?.playback.trackId) return null;
    return r.tracks.find((t) => t.id === r.playback.trackId) ?? null;
  });

  readonly queueTracks = computed<Track[]>(() => {
    const r = this.room.value;
    if (!r) return [];
    return r.queue
      .map((id) => r.tracks.find((t) => t.id === id))
      .filter((t): t is Track => t !== undefined);
  });

  /**
   * 由 player.ts 注册。播放锚点到达时同步调用 ——
   * 播放器必须在 room 更新之后再动，所以这里是回调而不是 signal。
   */
  onPlayback: ((playback: Playback, serverNow: number) => void) | null = null;

  async createRoom(name: string): Promise<string> {
    const res = await fetch('/api/rooms', { method: 'POST' });
    if (!res.ok) throw new Error(res.status === 429 ? '操作太频繁，稍后再试' : '创建失败');
    const { code } = (await res.json()) as { code: string };
    await this.join(code, name);
    return code;
  }

  async join(code: string, name: string): Promise<void> {
    const res = await fetch(`/api/rooms/${encodeURIComponent(code)}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, clientId: getOrCreateClientId() }),
    });
    if (!res.ok) {
      const message =
        res.status === 404 ? '房间不存在' : res.status === 429 ? '尝试太频繁，稍后再试' : '加入失败';
      this.error.value = message;
      throw new Error(message);
    }

    const { room } = (await res.json()) as { room: string };
    localStorage.setItem(LS_ROOM, room);
    localStorage.setItem(LS_NAME, name);
    this.myName.value = name;
    this.error.value = null;
    this.openSocket(room);
  }

  private openSocket(code: string): void {
    this.conn?.close();
    this.conn = connect(`/api/rooms/${code}/ws`, {
      onStatus: (s) => {
        this.status.value = s;
      },
      onMessage: (msg) => this.handle(msg),
    });
  }

  private handle(msg: unknown): void {
    const m = msg as Record<string, any>;
    switch (m.type) {
      case 'state':
        this.room.value = m.room as RoomState;
        this.error.value = null;
        break;

      case 'playback':
      case 'sync':
        this.applyPlayback(m.playback as Playback, m.serverNow as number);
        break;

      case 'queue': {
        const room = this.room.value;
        if (room && (m.epoch as number) >= room.epoch) {
          this.room.value = { ...room, queue: m.queue as string[], epoch: m.epoch as number };
        }
        break;
      }

      case 'tracks': {
        const room = this.room.value;
        if (room && (m.epoch as number) >= room.epoch) {
          this.room.value = { ...room, tracks: m.tracks as Track[], epoch: m.epoch as number };
        }
        break;
      }

      case 'members': {
        const room = this.room.value;
        if (room) this.room.value = { ...room, members: m.members };
        break;
      }

      case 'chat':
        this.chat.value = [...this.chat.value, m as ChatMessage].slice(-200);
        break;

      case 'error':
        this.error.value = String(m.message ?? '出错了');
        break;
    }
  }

  private applyPlayback(playback: Playback, serverNow: number): void {
    const room = this.room.value;
    if (!room) return;
    // 丢弃乱序到达的旧帧
    if (playback.trackId === room.playback.trackId && playback.seq < room.playback.seq) return;

    this.room.value = { ...room, playback };
    this.onPlayback?.(playback, serverNow);
  }

  send(msg: unknown): void {
    this.conn?.send(msg);
  }

  leave(): void {
    this.conn?.close();
    this.conn = null;
    this.room.value = null;
    this.chat.value = [];
    this.status.value = 'closed';
    localStorage.removeItem(LS_ROOM);
  }
}

export const store = new RoomStore();
