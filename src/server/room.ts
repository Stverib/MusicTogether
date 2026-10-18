import { DurableObject } from 'cloudflare:workers';
import {
  emptyPlayback,
  pauseAnchor,
  resumeAnchor,
  seekAnchor,
  startAnchor,
} from '../shared/playback';
import {
  CHAT_HISTORY_PAGE,
  CHAT_MAX_LENGTH,
  PING,
  PONG,
  parseClientMessage,
  type ServerMessage,
} from '../shared/protocol';
import type { ChatMessage, Playback, RoomState, Track } from '../shared/types';
import type { Env } from './env';
import { MAX_ROOM_BYTES, MAX_TRACKS_PER_ROOM } from './media';

const STORAGE_KEY = 'room';

/**
 * 聊天单独一个存储键，**不放进 RoomState**。
 *
 * 原因是 RoomState 每次播放/暂停/切歌都会整个 save() 一遍；聊天并进去的话，
 * 每次点暂停都要把整份聊天记录重写一次存储，而它只会越来越大。
 */
const CHAT_KEY = 'chat';

/** 播放中每 30 秒发一次兜底同步帧。暂停时完全不发（免费额度的生命线）。 */
const SYNC_INTERVAL_MS = 30_000;

/**
 * 成员列表上限。只淘汰离线的最老的，在线的一个都不动。
 * 长期房间否则会无限增长，而每份快照都要带上整份列表。
 */
const MAX_MEMBERS = 20;

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
export class RoomDO extends DurableObject<Env> {
  private room: RoomState | null = null;
  private chat: ChatMessage[] = [];
  /** 房间内单调递增的消息序号，也是"取更早"的游标 */
  private chatSeq = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // 应用层心跳由运行时直接应答，这类往返不会唤醒房间
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
    this.ctx.blockConcurrencyWhile(async () => {
      this.room = (await this.ctx.storage.get<RoomState>(STORAGE_KEY)) ?? null;
      this.chat = (await this.ctx.storage.get<ChatMessage[]>(CHAT_KEY)) ?? [];
      // 序号从已有记录的末尾续上。不这么做的话 DO 被驱逐一次，
      // 新消息的 id 就从头开始，"取更早"的游标会指到错的地方
      this.chatSeq = this.chat[this.chat.length - 1]?.id ?? 0;
    });
  }

  // ---------- 持久化 ----------

  private requireRoom(): RoomState {
    if (!this.room) throw new Error('room not initialized');
    return this.room;
  }

  private async save(): Promise<void> {
    if (this.room) await this.ctx.storage.put(STORAGE_KEY, this.room);
  }

  // ---------- 广播 ----------

  private broadcast(msg: ServerMessage, except?: WebSocket): void {
    const data = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
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

  override async fetch(request: Request): Promise<Response> {
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
      case '/chat-history': {
        const raw = url.searchParams.get('before');
        const before = raw === null ? Number.POSITIVE_INFINITY : Number(raw);
        return Response.json(
          this.chatHistory(Number.isFinite(before) ? before : Number.POSITIVE_INFINITY),
        );
      }
      case '/ws':
        return this.handleWebSocket(request);
      case '/track-add':
        return this.addTrack(request);
      case '/track-meta': {
        // 上传字节时用来决定 R2 的 customMetadata.name，以及核对实际字节数。
        // 以 DO 里的登记为准，而不是让客户端在 PUT 时自己声明。
        const track = this.room.tracks.find((t) => t.id === url.searchParams.get('trackId'));
        return track
          ? Response.json({ ok: true, name: track.name, size: track.size })
          : new Response('no such track', { status: 404 });
      }
      case '/track-ready':
        return this.markReady(request);
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
    // 注意：这里**不**入队。登记只代表"这个名字占下了"，
    // 字节还没进 R2。此时就让它出现在队列里，另一端点播放只会拿到 404。
    // 入队由 markReady 在 PUT 成功之后触发。
    room.epoch++;
    await this.save();
    this.broadcast({ type: 'tracks', tracks: room.tracks, epoch: room.epoch });
    return Response.json({ ok: true });
  }

  /**
   * 字节已经落到 R2，这首现在真的能播了 —— 到这一步才进队列。
   *
   * 由 Worker 在 PUT 成功后调用，而不是由客户端自己宣布：
   * 队列里出现的每一首，都保证是能播的。
   */
  private async markReady(request: Request): Promise<Response> {
    const { trackId } = (await request.json()) as { trackId?: string };
    const room = this.requireRoom();
    if (typeof trackId !== 'string') return new Response('bad track id', { status: 400 });
    if (!room.tracks.some((t) => t.id === trackId)) {
      return new Response('no such track', { status: 404 });
    }
    if (room.queue.includes(trackId)) return Response.json({ ok: true }); // 幂等

    room.queue.push(trackId);
    room.epoch++;
    await this.save();
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
      await this.ctx.storage.deleteAlarm();
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
    this.ctx.acceptWebSocket(server, [clientId]);

    await this.addMember(clientId, name);
    server.send(
      JSON.stringify({
        type: 'state',
        room: this.requireRoom(),
        // 只带最近一页。全量发会撞上 WebSocket 单帧 1 MiB 的上限，
        // 更早的走 /chat-history 按需取
        chat: this.chatHistory(Number.POSITIVE_INFINITY),
        chatTotal: this.chat.length,
        serverNow: Date.now(),
      } satisfies ServerMessage),
    );
    this.broadcast({ type: 'members', members: this.requireRoom().members }, server);

    return new Response(null, { status: 101, webSocket: client });
  }

  private async addMember(clientId: string, name: string): Promise<void> {
    const room = this.requireRoom();
    const existing = room.members.find((m) => m.clientId === clientId);
    if (existing) {
      // 同一个 clientId 又连上了（重连、或者开了第二个标签页）—— 翻回在线
      const changed = existing.name !== name || !existing.online;
      existing.name = name;
      existing.online = true;
      if (changed) await this.save();
      return;
    }
    room.members.push({ clientId, name, joinedAt: Date.now(), online: true });
    this.trimMembers(room);
    await this.save();
  }

  /**
   * 成员列表的上限。**只淘汰离线的最老的** —— 在线的人一个都不动。
   *
   * 否则房间开得够久、来来去去够多之后，这个列表会无限长；而如果简单按
   * 加入时间淘汰，第三十一个人进来会把正在听歌的人从列表里踢出去。
   */
  private trimMembers(room: RoomState): void {
    const over = room.members.length - MAX_MEMBERS;
    if (over <= 0) return;
    const drop = new Set(
      room.members
        .filter((m) => !m.online)
        .sort((a, b) => a.joinedAt - b.joinedAt)
        .slice(0, over)
        .map((m) => m.clientId),
    );
    if (drop.size) room.members = room.members.filter((m) => !drop.has(m.clientId));
  }

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== 'string') return;
    const room = this.requireRoom();
    const msg = parseClientMessage(raw);
    if (!msg) return;

    const tag = this.ctx.getTags(ws)[0] ?? '';

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
        await this.ctx.storage.deleteAlarm();
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
          await this.ctx.storage.deleteAlarm();
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
        // 必须是字符串，不做隐式强转 —— String(123) 会把数字悄悄变成文本收下
        if (typeof msg.text !== 'string') break;
        const text = msg.text.trim();
        if (!text || text.length > CHAT_MAX_LENGTH) break;
        const member = room.members.find((m) => m.clientId === tag);
        const message: ChatMessage = {
          id: ++this.chatSeq,
          from: tag,
          name: member?.name ?? '匿名',
          // 原样存、原样发，不做 HTML 转义 —— 转义是输出端（前端）的责任
          text,
          at: Date.now(),
        };
        this.chat.push(message);
        await this.ctx.storage.put(CHAT_KEY, this.chat);
        this.broadcast({ type: 'chat', ...message });
        break;
      }

      default:
        break;
    }
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    const tag = this.ctx.getTags(ws)[0] ?? '';
    // 只有这个 clientId 已经没有活着的连接时，才算真的离线
    const stillHere = this.ctx
      .getWebSockets()
      .some((s) => (this.ctx.getTags(s)[0] ?? '') === tag);
    if (stillHere) return;

    const room = this.room;
    if (!room) return;
    const member = room.members.find((m) => m.clientId === tag);
    // 这里**不删人**，只翻成离线。删掉的话"已离开"就无从显示
    if (!member || !member.online) return;
    member.online = false;
    await this.save();
    this.broadcast({ type: 'members', members: room.members });
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }

  override async alarm(): Promise<void> {
    const room = this.room;
    if (!room || !room.playback.isPlaying) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    this.broadcast({ type: 'sync', playback: room.playback, serverNow: Date.now() });
    await this.ctx.storage.setAlarm(Date.now() + SYNC_INTERVAL_MS);
  }

  /** 取 `before` 之前的最近一页。`before` 为 Infinity 就是取最新那一页 */
  private chatHistory(before: number): ChatMessage[] {
    const firstAtOrAfter = this.chat.findIndex((m) => m.id >= before);
    const cut = firstAtOrAfter === -1 ? this.chat.length : firstAtOrAfter;
    return this.chat.slice(Math.max(0, cut - CHAT_HISTORY_PAGE), cut);
  }

  // ---------- 内部 ----------

  /** 播放中才调度兜底同步帧；暂停时没有任何周期性消息 */
  private async scheduleSync(playback: Playback): Promise<void> {
    if (playback.isPlaying) {
      await this.ctx.storage.setAlarm(Date.now() + SYNC_INTERVAL_MS);
    } else {
      await this.ctx.storage.deleteAlarm();
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
        await this.ctx.storage.deleteAlarm();
      }
      return;
    }

    room.playback = startAnchor(room.queue[nextIdx]!, Date.now());
    await this.save();
    this.broadcastPlayback(room.playback);
    await this.scheduleSync(room.playback);
  }
}
