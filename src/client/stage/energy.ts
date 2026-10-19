/**
 * 律动数据。
 *
 * **只在本地算，绝不上行。** 每秒 60 帧的音频能量如果走 WebSocket，
 * 会立刻撞死 DO 的 100,000 次/日免费额度（docs/spec.md §6.3）。
 *
 * 本文件是纯函数，不碰 DOM，所以能在 node 里测。
 * 算法与三层获取分别见下面与 `analyser.ts`。
 */
export type Energy = { level: number; bass: number; treble: number };

export const SILENT: Energy = { level: 0, bass: 0, treble: 0 };
