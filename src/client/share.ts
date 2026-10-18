import { isValidCode, normalizeCode } from '../shared/codes';

/**
 * 分享链接的形状：`/r/<房间码>`。
 *
 * 房间码在 URL 里，所以它会进浏览器历史、也可能进聊天软件的链接预览。
 * 能接受的原因：房间码本来就是唯一的秘密，分享链接就是"把秘密给对方"。
 * 已经做的缓解是 `Referrer-Policy: no-referrer`（外链带不走它）与
 * CSP `default-src 'self'`（页面里没有任何第三方能读到 URL）。
 * 见 docs/security.md §2.10。
 */
export function roomLink(code: string): string {
  return `${location.origin}/r/${code}`;
}

/**
 * 从地址里取出分享的房间码。认 `/r/CODE`，也认 `?r=CODE`（老式写法，兼容）。
 * 格式不合法就返回 null —— 不合法的东西不该被当成房间码往下传。
 */
export function codeFromUrl(pathname: string, search: string): string | null {
  const fromPath = /^\/r\/([^/]+)\/?$/.exec(pathname)?.[1];
  let raw = fromPath;
  if (!raw) {
    try {
      raw = new URLSearchParams(search).get('r') ?? undefined;
    } catch {
      return null;
    }
  }
  if (!raw) return null;

  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null; // 畸形的百分号编码
  }
  const code = normalizeCode(decoded);
  return isValidCode(code) ? code : null;
}

export type ShareOutcome = 'shared' | 'copied' | 'manual';

/**
 * 把房间分享出去。
 *
 * 手机上优先用系统分享面板（微信、QQ 都在里面，比"复制链接"顺手得多）；
 * 没有或失败就退回剪贴板。
 *
 * 注意 `navigator.share` 与 `navigator.clipboard` **都是安全上下文专属**，
 * 局域网 HTTP 下两个都不存在 —— 所以必须有最后的兜底，
 * 否则这个按钮在本地测试时就是个哑巴。
 */
export async function shareRoom(code: string): Promise<ShareOutcome> {
  const url = roomLink(code);

  if (typeof navigator.share === 'function') {
    try {
      await navigator.share({ title: 'MusicTogether', text: `一起听歌，房间 ${code}`, url });
      return 'shared';
    } catch (err) {
      // 用户自己取消不是失败，不要再弹一次"已复制"
      if ((err as Error).name === 'AbortError') return 'shared';
    }
  }

  return (await copyText(url)) ? 'copied' : 'manual';
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 权限被拒或非安全上下文，继续走兜底
  }

  // 兜底：临时 textarea + execCommand。已废弃但到处都还支持，
  // 而且是唯一在非安全上下文里能用的复制手段。
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
