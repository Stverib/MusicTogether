import {
  emptyPlayback,
  pauseAnchor,
  resumeAnchor,
  seekAnchor,
  startAnchor,
} from '../shared/playback';
import {
  CHAT_MAX_LENGTH,
  PING,
  PONG,
  parseClientMessage,
  type ServerMessage,
} from '../shared/protocol';
import type { Playback, RoomState, Track } from '../shared/types';
import type { Env } from './env';
import { MAX_ROOM_BYTES, MAX_TRACKS_PER_ROOM } from './media';

const STORAGE_KEY = 'room';

/** 播放中每 30 秒发一次兜底同步帧。暂停时完全不发（免费额度的生命线）。 */
const SYNC_INTERVAL_MS = 30_000;

/**
 * 一个房间。
 *
 * 两条必须守住的约束：
 *
 * 1. **DO 可能在任何两条消息之间被驱逐**，所以内存态必须能从 storage 重建。
 *    构造函数里的 blockConcurrencyWhile 保证任何处理器跑起来之前状态已经就位。
 *
 * 2. **WebSocket 消息计入免费计划的 100,000 次/日额度**，所以服务端只在状态
 *    *变化* 时说话，绝不周期性广播进度 —— 位置由客户端按锚点自行推算。
 */
export class RoomDO implements DurableObject {
  private room: RoomState | null = null;

  constructor(private state: DurableObjectState, private env: Env) {
    // 应用层心跳由运行时直接应答，这类往返不会唤醒房间
    this.state.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
    this.state.blockConcurrencyWhile(async () => {
      this.room = (await this.state.storage.get<RoomState>(STORAGE_KEY)) ?? null;
    });
  }

  // ---------- 持久化 ----------

  private requireRoom(): RoomState {
    if (!this.room) throw new Error('room not initialized');
    return this.room;
  }

  private async save(): Promise<void> {
    if (this.room) await this.state.storage.put(STORAGE_KEY, this.room);
  }

  // ---------- 广播 ----------

  private broadcast(msg: ServerMessage, except?: WebSocket): void {
    const data = JSON.stringify(msg);
    for (const ws of this.state.getWebSockets()) {
      if (ws === except) continue;
      try {
        ws.send(data);
      } catch {
        // 连接已断，close 处理器会负责清理
      }
    }
  }

  private broadcastPlayback(playback: Playback): void {
    this.broadcast({ type: 'playback', playback, serverNow: Date.now() });
  }

  // ---------- 路由 ----------

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/init' && request.method === 'POST') {
      return this.init(url.searchParams.get('code') ?? '');
    }
    if (path === '/exists') {
      return this.room ? Response.json({ ok: true }) : new Response('no room', { status: 404 });
    }

    if (!this.room) return new Response('no room', { status: 404 });

    switch (path) {
      case '/state':
        return Response.json(this.room);
      case '/ws':
        return this.handleWebSocket(request);
      case '/track-add':
        return this.addTrack(request);
      case '/track-meta': {
        // 上传字节时用来决定 R2 的 customMetadata.name。
        // 以 DO 里的登记为准，而不是让客户端在 PUT 时自己声明文件名。
        const track = this.room.tracks.find((t) => t.id === url.searchParams.get('trackId'));
        return track
          ? Response.json({ ok: true, name: track.name })
          : new Response('no such track', { status: 404 });
      }
      case '/track-remove':
        return this.removeTrack(request);
      case '/track-deletable': {
        const trackId = url.searchParams.get('trackId');
        const clientId = url.searchParams.get('clientId');
        const track = this.room.tracks.find((t) => t.id === trackId);
        return track && track.uploaderId === clientId
          ? Response.json({ ok: true })
          : new Response('forbidden', { status: 403 });
      }
      default:
        return new Response('not found', { status: 404 });
    }
  }

  private async init(code: string): Promise<Response> {
    if (this.room) return new Response('already exists', { status: 409 });
    this.room = {
      code,
      name: '',
      createdAt: Date.now(),
      members: [],
      tracks: [],
      queue: [],
      playback: emptyPlayback(),
      epoch: 0,
    };
    await this.save();
    return Response.json({ ok: true, code });
  }

  // ---------- 曲目 ----------

  private async addTrack(request: Request): Promise<Response> {
    const body = (await request.json()) as Partial<Track>;
    const room = this.requireRoom();

    // 安全文档 §2.7：每房间配额。否则拿到一个房间码就能把 R2 免费额度填满。
    if (room.tracks.length >= MAX_TRACKS_PER_ROOM) {
      return new Response('room is full', { status: 413 });
    }
    const usedBytes = room.tracks.reduce((sum, t) => sum + t.size, 0);
    if (usedBytes + Number(body.size ?? 0) > MAX_ROOM_BYTES) {
      return new Response('room storage quota exceeded', { status: 413 });
    }

    const track: Track = {
      id: String(body.id ?? ''),
      name: String(body.name ?? '未命名').slice(0, 200),
      size: Number(body.size ?? 0),
      mime: String(body.mime ?? 'audio/mpeg'),
      uploaderId: String(body.uploaderId ?? ''),
      uploaderName: String(body.uploaderName ?? '匿名'),
      addedAt: Date.now(),
    };
    room.tracks.push(track);
    room.queue.push(track.id);
    room.epoch++;
    await this.save();
    this.broadcast({ type: 'tracks', tracks: room.tracks, epoch: room.epoch });
    this.broadcast({ type: 'queue', queue: room.queue, epoch: room.epoch });
    return Response.json({ ok: true });
  }

  private async removeTrack(request: Request): Promise<Response> {
    const { trackId } = (await request.json()) as { trackId: string };
    const room = this.requireRoom();

    room.tracks = room.tracks.filter((t) => t.id !== trackId);
    room.queue = room.queue.filter((id) => id !== trackId);
    if (room.playback.trackId === trackId) {
      room.playback = emptyPlayback();
      await this.state.storage.deleteAlarm();
      this.broadcastPlayback(room.playback);
    }
    room.epoch++;
    await this.save();
    this.broadcast({ type: 'tracks', tracks: room.tracks, epoch: room.epoch });
    this.broadcast({ type: 'queue', queue: room.queue, epoch: room.epoch });
    return Response.json({ ok: true });
  }

  // ---------- WebSocket ----------

  private async handleWebSocket(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }
    const clientId = request.headers.get('X-Client-Id');
    const name = decodeURIComponent(request.headers.get('X-Client-Name') ?? '') || '匿名';
    if (!clientId) return new Response('missing identity', { status: 400 });

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.state.acceptWebSocket(server, [clientId]);

    await this.addMember(clientId, name);
    server.send(JSON.stringify({ type: 'state', room: this.room } satisfies ServerMessage));
    this.broadcast({ type: 'members', members: this.requireRoom().members }, server);

    return new Response(null, { status: 101, webSocket: client });
  }

  private async addMember(clientId: string, name: string): Promise<void> {
    const room = this.requireRoom();
    const existing = room.members.find((m) => m.clientId === clientId);
    if (existing) {
      if (existing.name !== name) {
        existing.name = name;
        await this.save();
      }
      return;
    }
    room.members.push({ clientId, name, joinedAt: Date.now() });
    await this.save();
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== 'string') return;
    const room = this.requireRoom();
    const msg = parseClientMessage(raw);
    if (!msg) return;

    const tag = this.state.getTags(ws)[0] ?? '';

    switch (msg.type) {
      case 'hello': {
        const name = String(msg.name ?? '').trim().slice(0, 24) || '匿名';
        await this.addMember(tag, name);
        this.broadcast({ type: 'members', members: room.members });
        break;
      }

      case 'play': {
        if (typeof msg.trackId !== 'string') break;
        if (!room.tracks.some((t) => t.id === msg.trackId)) break;
        room.playback = startAnchor(msg.trackId, Date.now());
        await this.save();
        this.broadcastPlayback(room.playback);
        await this.scheduleSync(room.playback);
        break;
      }

      case 'pause': {
        if (room.playback.trackId === null || !room.playback.isPlaying) break;
        room.playback = pauseAnchor(room.playback, Date.now());
        await this.save();
        this.broadcastPlayback(room.playback);
        await this.state.storage.deleteAlarm();
        break;
      }

      case 'resume': {
        if (room.playback.trackId === null || room.playback.isPlaying) break;
        room.playback = resumeAnchor(room.playback, Date.now());
        await this.save();
        this.broadcastPlayback(room.playback);
        await this.scheduleSync(room.playback);
        break;
      }

      case 'seek': {
        if (room.playback.trackId === null) break;
        if (typeof msg.positionMs !== 'number' || !Number.isFinite(msg.positionMs)) break;
        room.playback = seekAnchor(room.playback, Date.now(), msg.positionMs);
        await this.save();
        this.broadcastPlayback(room.playback);
        break;
      }

      case 'next':
        await this.step(1);
        break;

      case 'prev':
        await this.step(-1);
        break;

      case 'enqueue': {
        if (typeof msg.trackId !== 'string') break;
        if (!room.tracks.some((t) => t.id === msg.trackId)) break;
        if (room.queue.includes(msg.trackId)) break;
        room.queue.push(msg.trackId);
        room.epoch++;
        await this.save();
        this.broadcast({ type: 'queue', queue: room.queue, epoch: room.epoch });
        break;
      }

      case 'dequeue': {
        if (typeof msg.trackId !== 'string') break;
        if (!room.queue.includes(msg.trackId)) break;
        room.queue = room.queue.filter((id) => id !== msg.trackId);
        room.epoch++;
        if (room.playback.trackId === msg.trackId) {
          room.playback = emptyPlayback();
          await this.state.storage.deleteAlarm();
          this.broadcastPlayback(room.playback);
        }
        await this.save();
        this.broadcast({ type: 'queue', queue: room.queue, epoch: room.epoch });
        break;
      }

      case 'reorder': {
        if (!Array.isArray(msg.queue)) break;
        // 必须与现有队列是同一个集合的排列，否则忽略 ——
        // 客户端状态过期时提交的旧顺序会悄悄丢歌
        if (msg.queue.length !== room.queue.length) break;
        const current = new Set(room.queue);
        if (!msg.queue.every((id) => typeof id === 'string' && current.has(id))) break;
        if (new Set(msg.queue).size !== msg.queue.length) break;
        room.queue = [...msg.queue];
        room.epoch++;
        await this.save();
        this.broadcast({ type: 'queue', queue: room.queue, epoch: room.epoch });
        break;
      }

      case 'chat': {
        const text = String(msg.text ?? '').trim();
        if (!text || text.length > CHAT_MAX_LENGTH) break;
        const member = room.members.find((m) => m.clientId === tag);
        // 原样广播，不做 HTML 转义 —— 转义是输出端（前端）的责任
        this.broadcast({
          type: 'chat',
          from: tag,
          name: member?.name ?? '匿名',
          text,
          at: Date.now(),
        });
        break;
      }

      default:
        break;
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const tag = this.state.getTags(ws)[0] ?? '';
    // 只有这个 clientId 已经没有活着的连接时，才算真正离开
    const stillHere = this.state
      .getWebSockets()
      .some((s) => (this.state.getTags(s)[0] ?? '') === tag);
    if (stillHere) return;

    const room = this.room;
    if (!room) return;
    room.members = room.members.filter((m) => m.clientId !== tag);
    await this.save();
    this.broadcast({ type: 'members', members: room.members });
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }

  async alarm(): Promise<void> {
    const room = this.room;
    if (!room || !room.playback.isPlaying) {
      await this.state.storage.deleteAlarm();
      return;
    }
    this.broadcast({ type: 'sync', playback: room.playback, serverNow: Date.now() });
    await this.state.storage.setAlarm(Date.now() + SYNC_INTERVAL_MS);
  }

  // ---------- 内部 ----------

  /** 播放中才调度兜底同步帧；暂停时没有任何周期性消息 */
  private async scheduleSync(playback: Playback): Promise<void> {
    if (playback.isPlaying) {
      await this.state.storage.setAlarm(Date.now() + SYNC_INTERVAL_MS);
    } else {
      await this.state.storage.deleteAlarm();
    }
  }

  private async step(delta: 1 | -1): Promise<void> {
    const room = this.requireRoom();
    const idx = room.playback.trackId ? room.queue.indexOf(room.playback.trackId) : -1;
    const nextIdx = idx + delta;

    if (nextIdx < 0 || nextIdx >= room.queue.length) {
      // 到头了：停在最后一首的末尾（暂停），不回绕
      if (room.playback.trackId && delta === 1) {
        room.playback = pauseAnchor(room.playback, Date.now());
        await this.save();
        this.broadcastPlayback(room.playback);
        await this.state.storage.deleteAlarm();
      }
      return;
    }

    room.playback = startAnchor(room.queue[nextIdx]!, Date.now());
    await this.save();
    this.broadcastPlayback(room.playback);
    await this.scheduleSync(room.playback);
  }
}
