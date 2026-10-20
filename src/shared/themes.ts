/**
 * 房间主题的白名单。
 *
 * 放在 shared 而不是 client：**服务端也要校验**，两边必须认同同一份 id 表。
 * 主题 id 会落进 DO 的持久化状态并广播给全房间，所以它必须是一个封闭集合 ——
 * 任意字符串既能把房间状态撑大，也会让服务端不认识的取值流到客户端。
 *
 * 新增主题时只改这个数组，再往 `src/client/stage/themes/` 加一份实现。
 */
export const THEME_IDS = ['dawn', 'ember'] as const;

export type ThemeId = (typeof THEME_IDS)[number];

export const DEFAULT_THEME: ThemeId = 'dawn';

export function isThemeId(v: unknown): v is ThemeId {
  return typeof v === 'string' && (THEME_IDS as readonly string[]).includes(v);
}

/**
 * 把"可能是任何东西"的取值折回一个合法主题。
 *
 * 两个地方用它：服务端从持久化状态里读旧房间（那时还没有 theme 字段），
 * 客户端读快照。少了它，老房间会拿到 undefined，查表查不到，场景直接不出来。
 */
export function themeOrDefault(v: unknown): ThemeId {
  return isThemeId(v) ? v : DEFAULT_THEME;
}
