import type { ThemeId } from '../../../shared/themes';
import { createDawnTheme } from './dawn';
import type { ThemeFactory } from './types';

/** 新增主题：在 src/shared/themes.ts 的 THEME_IDS 里加 id，在这里加一行 */
export const THEME_FACTORIES: Record<ThemeId, ThemeFactory> = {
  dawn: createDawnTheme,
};
