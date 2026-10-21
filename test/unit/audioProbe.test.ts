import { describe, it, expect } from 'vitest';
import { moovHasAudioTrack, probeAudio } from '../../src/client/audioProbe';

const enc = new TextEncoder();

function box(type: string, ...parts: Uint8Array[]): Uint8Array {
  const bodyLength = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(8 + bodyLength);
  new DataView(out.buffer).setUint32(0, out.length);
  out.set(enc.encode(type), 4);
  let at = 8;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function hdlr(handler: string): Uint8Array {
  const body = new Uint8Array(12);
  body.set(enc.encode(handler), 8);
  return box('hdlr', body);
}

function trak(handler: string): Uint8Array {
  return box('trak', box('mdia', hdlr(handler)));
}

function moov(...tracks: Uint8Array[]): Uint8Array {
  return box('moov', ...tracks);
}

function ftyp(): Uint8Array {
  return box('ftyp', enc.encode('isom'), new Uint8Array(4));
}

function file(bytes: Uint8Array, name = 'song.mp3'): File {
  return new File([new Uint8Array(bytes)], name);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

describe('MP4 音轨探测', () => {
  it('只有视频轨时返回 false', () => {
    expect(moovHasAudioTrack(moov(trak('vide')).subarray(8))).toBe(false);
  });

  it('有音频轨时返回 true', () => {
    expect(moovHasAudioTrack(moov(trak('soun')).subarray(8))).toBe(true);
  });

  it('音视频都有时返回 true', () => {
    expect(moovHasAudioTrack(moov(trak('vide'), trak('soun')).subarray(8))).toBe(true);
  });

  it('结构里找不到 trak 时返回 null，避免误杀', () => {
    expect(moovHasAudioTrack(new Uint8Array(0))).toBe(null);
    expect(moovHasAudioTrack(moov().subarray(8))).toBe(null);
  });
});

describe('选文件时的探针', () => {
  it('扩展名是 mp3、实际是纯视频 MP4：拒绝', async () => {
    expect(await probeAudio(file(concat(ftyp(), moov(trak('vide')))))).toBe('no-audio');
  });

  it('MP4 里有音频轨（哪怕还有视频轨）：放行', async () => {
    expect(await probeAudio(file(concat(ftyp(), moov(trak('vide'), trak('soun')))))).toBe('ok');
  });

  it('moov 在文件末尾也能找到，不必读整首歌', async () => {
    const mdat = box('mdat', new Uint8Array(1024 * 1024));
    const bytes = concat(ftyp(), mdat, moov(trak('soun')));
    expect(await probeAudio(file(bytes))).toBe('ok');
  });

  it('不是 MP4 的常见音频不解析，直接放行', async () => {
    expect(await probeAudio(file(enc.encode('ID3\u0003\u0000\u0000')))).toBe('ok');
    expect(await probeAudio(file(enc.encode('RIFF....WAVE')))).toBe('ok');
  });

  it('认不出 moov 时返回 unknown，而不是断言没音轨', async () => {
    expect(await probeAudio(file(concat(ftyp(), box('free', new Uint8Array(8)))))).toBe('unknown');
  });
});
