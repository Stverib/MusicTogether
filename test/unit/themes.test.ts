import { describe, expect, it } from 'vitest';
import { DEFAULT_THEME, THEME_IDS, isThemeId, themeOrDefault } from '../../src/shared/themes';

describe('主题 id 白名单', () => {
  it('认白名单里的每一个 id', () => {
    for (const id of THEME_IDS) expect(isThemeId(id)).toBe(true);
  });

  it('拒绝未知 id、大小写变体、空串与非字符串', () => {
    const bad: unknown[] = ['starfield', '', 'DAWN', ' dawn', 0, null, undefined, {}, [], true];
    for (const v of bad) expect(isThemeId(v)).toBe(false);
  });

  it('默认主题一定在白名单里', () => {
    expect(isThemeId(DEFAULT_THEME)).toBe(true);
  });

  it('themeOrDefault 把未知值折回默认主题', () => {
    expect(themeOrDefault('dawn')).toBe('dawn');
    expect(themeOrDefault(undefined)).toBe(DEFAULT_THEME);
    expect(themeOrDefault('starfield')).toBe(DEFAULT_THEME);
    expect(themeOrDefault(42)).toBe(DEFAULT_THEME);
  });
});
