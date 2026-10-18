import { describe, it, expect } from 'vitest';
import { generateCode, normalizeCode, isValidCode, CODE_ALPHABET, CODE_LENGTH } from '../../src/shared/codes';

describe('房间码', () => {
  it('生成的码长度固定且只含字母表内字符', () => {
    for (let i = 0; i < 500; i++) {
      const c = generateCode();
      expect(c).toHaveLength(CODE_LENGTH);
      for (const ch of c) expect(CODE_ALPHABET).toContain(ch);
    }
  });

  it('生成的码有足够随机性（500 次不重复）', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(generateCode());
    expect(seen.size).toBe(500);
  });

  it('归一化：小写转大写、剔除分隔符与空格', () => {
    expect(normalizeCode('k7m-2qx')).toBe('K7M2QX');
    expect(normalizeCode(' K7M 2QX ')).toBe('K7M2QX');
  });

  it('归一化：修正易混字符 O→0 I→1 L→1 U→V', () => {
    expect(normalizeCode('OILU')).toBe('011V');
  });

  it('校验：合法码通过，长度或字符不合法则失败', () => {
    expect(isValidCode('K7M2QX')).toBe(true);
    expect(isValidCode('k7m2qx')).toBe(true);
    expect(isValidCode('K7M2Q')).toBe(false);
    expect(isValidCode('K7M2QXZ')).toBe(false);
    expect(isValidCode('K7M2Q!')).toBe(false);
  });
});
