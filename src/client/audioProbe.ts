/**
 * 有些「.mp3」其实是改了扩展名的 MP4 视频，甚至只有视频轨。
 * 浏览器按 audio/mpeg 去解，只会安静地停在开头 —— 用户看到的就是「没声音」。
 * 这里在选文件后做一个很轻的探针：MP4 容器里必须有 soun 轨才放行。
 * 其他格式（mp3/flac/wav/ogg…）不解析，交给浏览器。
 */

const MAX_MOOV_BYTES = 16 * 1024 * 1024;

function fourcc(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!);
}

function u32(bytes: Uint8Array, at: number): number {
  return (
    bytes[at]! * 0x1000000 +
    ((bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!)
  );
}

type Box = { type: string; body: number; end: number };

function* boxes(bytes: Uint8Array, start: number, end: number): Generator<Box> {
  let off = start;
  while (off + 8 <= end) {
    let size = u32(bytes, off);
    const type = fourcc(bytes, off + 4);
    let header = 8;

    if (size === 1) {
      if (off + 16 > end) return;
      size = u32(bytes, off + 8) * 0x100000000 + u32(bytes, off + 12);
      header = 16;
    } else if (size === 0) {
      size = end - off;
    }

    // 声明尺寸越界或小到放不下头，就别再往后猜了
    if (size < header || off + size > end) return;
    yield { type, body: off + header, end: off + size };
    off += size;
  }
}

/**
 * 返回 MP4 的 moov 里有没有音频轨。
 * null 表示没找到 trak（结构不认识），调用方应当放行而不是误杀。
 */
export function moovHasAudioTrack(moov: Uint8Array): boolean | null {
  let sawTrack = false;
  let sawAudio = false;

  for (const trak of boxes(moov, 0, moov.length)) {
    if (trak.type !== 'trak') continue;
    sawTrack = true;

    for (const mdia of boxes(moov, trak.body, trak.end)) {
      if (mdia.type !== 'mdia') continue;

      for (const hdlr of boxes(moov, mdia.body, mdia.end)) {
        // hdlr 体：version/flags(4) + pre_defined(4) + handler_type(4)
        if (hdlr.type !== 'hdlr' || hdlr.body + 12 > hdlr.end) continue;
        if (fourcc(moov, hdlr.body + 8) === 'soun') sawAudio = true;
      }
    }
  }

  return sawTrack ? sawAudio : null;
}

export type AudioProbe = 'ok' | 'no-audio' | 'unknown';

/**
 * 只读文件头和 box 头，不会把整首歌读进内存：
 * mdat 再大也是直接按尺寸跳过，真正读入的只有 moov（通常几十 KB）。
 */
export async function probeAudio(file: File): Promise<AudioProbe> {
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  if (head.length < 12 || fourcc(head, 4) !== 'ftyp') return 'ok';

  let offset = 0;
  while (offset + 8 <= file.size) {
    const header = new Uint8Array(await file.slice(offset, offset + 16).arrayBuffer());
    if (header.length < 8) return 'unknown';

    let size = u32(header, 0);
    const type = fourcc(header, 4);
    let headerBytes = 8;

    if (size === 1) {
      if (header.length < 16) return 'unknown';
      size = u32(header, 8) * 0x100000000 + u32(header, 12);
      headerBytes = 16;
    } else if (size === 0) {
      size = file.size - offset;
    }

    if (size < headerBytes) return 'unknown';

    if (type === 'moov') {
      if (size - headerBytes > MAX_MOOV_BYTES) return 'unknown';
      const body = new Uint8Array(
        await file.slice(offset + headerBytes, offset + size).arrayBuffer(),
      );
      const hasAudio = moovHasAudioTrack(body);
      if (hasAudio === null) return 'unknown';
      return hasAudio ? 'ok' : 'no-audio';
    }

    offset += size;
  }

  return 'unknown';
}
