import { describe, it, expect } from 'vitest';
import { AUDIO_EXT, filterAudio } from '../../src/client/sources';

const f = (name: string) => ({ name });

describe('音频文件筛选', () => {
  it('识别常见音频扩展名（大小写不敏感）', () => {
    const names = ['a.mp3', 'b.MP3', 'c.flac', 'd.m4a', 'e.aac', 'f.ogg', 'g.wav', 'h.opus', 'i.wma'];
    expect(filterAudio(names.map(f))).toHaveLength(names.length);
  });

  it('剔除非音频与隐藏文件', () => {
    const files = [f('cover.jpg'), f('notes.txt'), f('.DS_Store'), f('song.mp3')];
    expect(filterAudio(files).map((x) => x.name)).toEqual(['song.mp3']);
  });

  it('不误伤名字里带点的音频', () => {
    expect(filterAudio([f('01. 晴天.mp3')])).toHaveLength(1);
  });

  it('不误伤中文文件名', () => {
    expect(filterAudio([f('周杰伦 - 晴天.flac')])).toHaveLength(1);
  });

  it('扩展名正则不做全局匹配（避免 lastIndex 状态污染）', () => {
    // 带 /g 的正则连续 test() 会因 lastIndex 跳变而时灵时不灵 —— 这是经典陷阱
    expect(AUDIO_EXT.global).toBe(false);
  });

  it('连续多次调用结果一致', () => {
    const files = [f('a.mp3'), f('b.jpg')];
    for (let i = 0; i < 5; i++) {
      expect(filterAudio(files).map((x) => x.name)).toEqual(['a.mp3']);
    }
  });

  it('空列表返回空列表', () => {
    expect(filterAudio([])).toEqual([]);
  });
});
