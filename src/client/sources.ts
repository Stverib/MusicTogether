/**
 * 注意：不能用 /g —— 带 g 的正则在多次 test() 之间会保留 lastIndex，
 * 导致同一个文件有时匹配有时不匹配。
 */
export const AUDIO_EXT = /\.(mp3|m4a|aac|flac|ogg|oga|opus|wav|wma|aiff?)$/i;

export function filterAudio<T extends { name: string }>(files: T[]): T[] {
  return files.filter((f) => !f.name.startsWith('.') && AUDIO_EXT.test(f.name));
}

type DirEntry = { kind: string; name: string; getFile(): Promise<File> };
type DirHandle = { values(): AsyncIterable<DirEntry> };

declare global {
  interface Window {
    showDirectoryPicker?: (opts?: { mode?: string }) => Promise<DirHandle>;
  }
}

/**
 * 桌面 Chrome/Edge 的目录选择，体验最好。
 * 不支持时返回 null，由调用方退化到 webkitdirectory 或多选。
 */
export async function pickDirectory(): Promise<File[] | null> {
  if (!window.showDirectoryPicker) return null;
  try {
    const handle = await window.showDirectoryPicker({ mode: 'read' });
    const out: File[] = [];
    for await (const entry of handle.values()) {
      if (entry.kind === 'file') out.push(await entry.getFile());
    }
    return filterAudio(out);
  } catch {
    return null; // 用户取消，或权限被拒
  }
}

export type UploadProgress = (sent: number, total: number) => void;

/**
 * 登记元数据 → PUT 字节 → 入队。
 * 用 XHR 而不是 fetch，因为 fetch 没有上传进度事件。
 */
export async function uploadTrack(
  roomCode: string,
  file: File,
  onProgress?: UploadProgress,
): Promise<string> {
  const init = await fetch(`/api/rooms/${roomCode}/tracks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: file.name, size: file.size, mime: file.type || 'audio/mpeg' }),
  });
  if (!init.ok) throw new Error(init.status === 413 ? '房间已满' : `登记失败 (${init.status})`);

  const { trackId, uploadUrl } = (await init.json()) as { trackId: string; uploadUrl: string };

  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', uploadUrl);
    xhr.upload.onprogress = (e) => onProgress?.(e.loaded, e.total);
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(xhr.status === 413 ? '文件太大' : `上传失败 (${xhr.status})`));
    xhr.onerror = () => reject(new Error('网络错误'));
    xhr.send(file);
  });

  return trackId;
}
