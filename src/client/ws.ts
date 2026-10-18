import { PING, PONG } from '../shared/protocol';

export type ConnStatus = 'connecting' | 'open' | 'closed';

export type WsHandlers = {
  onMessage: (msg: unknown) => void;
  onStatus: (status: ConnStatus) => void;
};

/** 心跳间隔。Cloudflare 的空闲超时存在但时长未公开，所以必须自己保活。 */
const HEARTBEAT_MS = 25_000;
const MAX_BACKOFF_MS = 15_000;

/**
 * 带心跳与指数退避重连的 WebSocket 封装。
 *
 * 重连不是优化项而是必需项：Cloudflare 发布网络更新时会重启服务器，
 * 这会掐断 WebSocket。
 */
export function connect(url: string, handlers: WsHandlers) {
  let ws: WebSocket | null = null;
  let closed = false;
  let attempt = 0;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const stopHeartbeat = () => {
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
  };

  const open = () => {
    handlers.onStatus('connecting');
    ws = new WebSocket(url);

    ws.addEventListener('open', () => {
      attempt = 0;
      handlers.onStatus('open');
      stopHeartbeat();
      heartbeat = setInterval(() => {
        if (ws?.readyState === WebSocket.OPEN) ws.send(PING);
      }, HEARTBEAT_MS);
    });

    ws.addEventListener('message', (e) => {
      // pong 由运行时的 auto-response 直接产生，不需要往上抛
      if (e.data === PONG) return;
      try {
        handlers.onMessage(JSON.parse(e.data as string));
      } catch {
        // 忽略非 JSON 帧
      }
    });

    const dropped = () => {
      stopHeartbeat();
      ws = null;
      if (closed) return;
      handlers.onStatus('closed');
      const delay = Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS);
      attempt++;
      retryTimer = setTimeout(open, delay);
    };

    ws.addEventListener('close', dropped);
    ws.addEventListener('error', dropped);
  };

  open();

  return {
    send(msg: unknown) {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    },
    close() {
      closed = true;
      stopHeartbeat();
      if (retryTimer) clearTimeout(retryTimer);
      ws?.close();
    },
  };
}
