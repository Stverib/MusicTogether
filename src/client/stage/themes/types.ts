// 只 import type：这个文件会被 stage.ts 静态引用，不能把 three 拖进首屏
import type { Scene, WebGLRenderer } from 'three';
import type { Energy } from '../energy';
import type { QualityTier } from '../quality';

export interface ThemeContext {
  scene: Scene;
  renderer: WebGLRenderer;
  quality: QualityTier;
}

/**
 * 一个主题只负责**环境**：背景、雾、灯光、粒子。
 *
 * 唱片机不在这里 —— 它是房间的恒定中心，由 Stage 自己持有，
 * 所以切主题时它一直在转，不会被重建。
 */
export interface Theme {
  build(ctx: ThemeContext): void;
  /** 每帧。energy 是本地分析出来的，不是从服务端来的 */
  update(dtMs: number, energy: Energy): void;
  /** 交叉淡入淡出的权重：0 = 完全退场，1 = 完全在场 */
  setWeight(weight: number): void;
  dispose(): void;
}

export type ThemeFactory = () => Theme;
