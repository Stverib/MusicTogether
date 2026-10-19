import { computed, signal } from '@preact/signals';
import { isThemeId, themeOrDefault, type ThemeId } from '../shared/themes';
import type { ChatMessage, Playback, RoomState, Track } from '../shared/types';
import { connect, type ConnStatus } from './ws';

const LS_CLIENT_ID = 'mt_client_id';
const LS_ROOM = 'mt_room';
const LS_NAME = 'mt_name';

/**
 * `crypto.randomUUID()` **只在安全上下文里存在**。
 *
 * 安全上下文不只是 HTTPS：`http://localhost` 算，`http://192.168.1.5` 这种
 * 局域网地址不算。缺了它整页会白屏 —— Join 在渲染时就要用 clientId，
 * 一抛异常整个应用都出不来，而且手机上没有任何控制台可看。
 * `getRandomValues` 在非安全上下文里是有的，拿它兜底（同样是 128 位随机）。
 */
function newClientId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** 身份存在这台设备的浏览器里。没有账号系统，这就是全部的身份。 */
export function getOrCreateClientId(): string {
  let id = localStorage.getItem(LS_CLIENT_ID);
  if (!id) {
    id = newClientId();
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
  /** 房间里聊天记录的总条数。大于本地已加载的条数就说明还有更早的没取 */
  readonly chatTotal = signal(0);
  readonly loadingOlder = signal(false);
  readonly myName = signal<string>(savedName());

  private conn: ReturnType<typeof connect> | null = null;

  constructor() {
    // 页面一不可见就算"离开"。最小化窗口、切到别的应用、手机按 home 键
    // 都不会断开 WebSocket，光看连接状态是看不出来的，所以另开一路上报。
    //
    // 常驻监听而不是随连接挂卸：连接会断线重连，可见性不会。
    document.addEventListener('visibilitychange', () => this.reportPresence());
  }

  /** 把"页面还在不在前台"告诉服务端。没有连接时什么也不做。 */
  private reportPresence(): void {
    this.send({ type: 'presence', away: document.hidden });
  }

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
    // 从分享链接进来的话，加入之后把地址栏还原成 /
    // —— 房间码是秘密，没必要一直挂在历史和截图里。房间已经记进 localStorage，
    // 刷新照样回得来。
    if (location.pathname.startsWith('/r/')) history.replaceState(null, '', '/');
    this.openSocket(room);
  }

  private openSocket(code: string): void {
    this.conn?.close();
    this.conn = connect(`/api/rooms/${code}/ws`, {
      onStatus: (s) => {
        this.status.value = s;
        // 重连时服务端会把人翻回在线。如果这个页面此刻在后台，
        // 那一下翻错了，得立刻纠正回来
        if (s === 'open') this.reportPresence();
      },
      onMessage: (msg) => this.handle(msg),
    });
  }

  private handle(msg: unknown): void {
    const m = msg as Record<string, any>;
    switch (m.type) {
      case 'state': {
        const room = m.room as RoomState;
        this.room.value = room;
        this.error.value = null;
        // 快照只带最近一页，更早的靠 chatTotal 与「加载更早」按钮去取
        this.chat.value = (m.chat as ChatMessage[] | undefined) ?? [];
        this.chatTotal.value = typeof m.chatTotal === 'number' ? m.chatTotal : this.chat.value.length;
        // 快照是权威的，直接用它对齐播放器 —— 中途进房/重连后立即就能对上，
        // 不必等下一次周期性同步帧
        if (typeof m.serverNow === 'number') {
          this.onPlayback?.(room.playback, m.serverNow);
        }
        break;
      }

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
        // 不再截断：聊天现在会落库，界面上的条数该和房间里的一致
        this.chat.value = [...this.chat.value, m as ChatMessage];
        this.chatTotal.value = Math.max(this.chatTotal.value, this.chat.value.length);
        break;

      case 'theme': {
        const room = this.room.value;
        // 查表用的值必须兜底：服务端已经校验过，但客户端不该依赖这一点 ——
        // 少兜一层的话，一个未知主题会让场景直接不出来
        if (room) this.room.value = { ...room, theme: themeOrDefault(m.theme) };
        break;
      }

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

  /** 换房间主题。房间级、平权 —— 跟播放/暂停一样，谁都能改 */
  setTheme(theme: ThemeId): void {
    // 白名单在这里再挡一次。值来自我们自己的按钮，但边界是双向的：
    // 服务端也校验，客户端也校验，谁都不依赖对方
    if (!isThemeId(theme)) return;
    this.send({ type: 'theme', theme });
  }

  /**
   * 取更早的一页聊天。
   *
   * 服务端一条都没删 —— 只是 WebSocket 单帧装不下全部，所以快照只带最近一页，
   * 更早的按需拉。游标用消息自己的 id，不用时间戳：同一毫秒内可能有多条。
   */
  async loadOlderChat(): Promise<void> {
    const room = this.room.value;
    const oldest = this.chat.value[0];
    if (!room || !oldest || this.loadingOlder.value) return;

    this.loadingOlder.value = true;
    try {
      const res = await fetch(
        `/api/rooms/${encodeURIComponent(room.code)}/chat?before=${oldest.id}`,
      );
      if (!res.ok) return;
      const older = (await res.json()) as ChatMessage[];
      if (Array.isArray(older) && older.length) {
        this.chat.value = [...older, ...this.chat.value];
      }
    } catch {
      // 拉不到就算了，界面上那颗按钮还在，可以再点
    } finally {
      this.loadingOlder.value = false;
    }
  }

  leave(): void {
    this.conn?.close();
    this.conn = null;
    this.room.value = null;
    this.chat.value = [];
    this.chatTotal.value = 0;
    this.status.value = 'closed';
    localStorage.removeItem(LS_ROOM);
  }
}

export const store = new RoomStore();
