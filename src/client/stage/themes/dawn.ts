import * as THREE from 'three';
import type { Energy } from '../energy';
import type { QualityTier } from '../quality';
import type { Theme, ThemeContext } from './types';

/** 晨光：粉白做雾与背景，浅橙做主光与粒子，淡墨绿做对比色 */
export const DAWN = {
  pinkWhite: 0xfdf4f0,
  lightOrange: 0xf2a172,
  paleInkGreen: 0x8fa89a,
} as const;

const PARTICLE_COUNT: Record<QualityTier, number> = {
  high: 1200,
  medium: 500,
  low: 150,
};

export function createDawnTheme(): Theme {
  let group: THREE.Group | null = null;
  let points: THREE.Points | null = null;
  let drift: Float32Array | null = null;
  let key: THREE.PointLight | null = null;
  let weight = 1;

  return {
    build(ctx: ThemeContext) {
      const scene = ctx.scene;
      scene.background = new THREE.Color(DAWN.pinkWhite);
      scene.fog = new THREE.Fog(DAWN.pinkWhite, 6, 18);

      group = new THREE.Group();

      // 主光：浅橙，打亮唱片机
      key = new THREE.PointLight(DAWN.lightOrange, 24, 20, 2);
      key.position.set(1.6, 2.6, 2.2);
      group.add(key);
      // 补光：淡墨绿，从另一侧压一下，否则整屏只有一个色系会糊
      const fill = new THREE.PointLight(DAWN.paleInkGreen, 8, 18, 2);
      fill.position.set(-2.2, 1.2, -1.4);
      group.add(fill);
      group.add(new THREE.AmbientLight(DAWN.pinkWhite, 1.6));

      // 粒子：细小的光点缓慢漂浮
      const count = PARTICLE_COUNT[ctx.quality];
      const positions = new Float32Array(count * 3);
      drift = new Float32Array(count);
      for (let i = 0; i < count; i++) {
        const r = 2.4 + Math.random() * 5.5;
        const a = Math.random() * Math.PI * 2;
        positions[i * 3] = Math.cos(a) * r;
        positions[i * 3 + 1] = (Math.random() - 0.35) * 5;
        positions[i * 3 + 2] = Math.sin(a) * r;
        drift[i] = 0.15 + Math.random() * 0.5;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      points = new THREE.Points(
        geo,
        new THREE.PointsMaterial({
          color: DAWN.lightOrange,
          size: 0.035,
          transparent: true,
          opacity: 0.9,
          depthWrite: false,
        }),
      );
      group.add(points);
      scene.add(group);
    },

    update(dtMs: number, energy: Energy) {
      if (!points || !drift) return;
      const pos = points.geometry.getAttribute('position') as THREE.BufferAttribute;
      const arr = pos.array as Float32Array;
      // 低音把粒子往外推，高音让它们整体变亮
      const push = 1 + energy.bass * 0.12;
      for (let i = 0; i < drift.length; i++) {
        arr[i * 3 + 1] = (arr[i * 3 + 1] ?? 0) + drift[i]! * dtMs * 0.0004;
        arr[i * 3] = (arr[i * 3] ?? 0) * (1 + (push - 1) * 0.02);
        arr[i * 3 + 2] = (arr[i * 3 + 2] ?? 0) * (1 + (push - 1) * 0.02);
      }
      pos.needsUpdate = true;
      const mat = points.material as THREE.PointsMaterial;
      mat.opacity = (0.45 + energy.level * 0.5) * weight;
      mat.size = (0.03 + energy.treble * 0.03) * (0.6 + weight * 0.4);
      if (key) key.intensity = (10 + energy.bass * 26) * weight;
    },

    setWeight(w: number) {
      weight = w;
      if (group) group.visible = w > 0.001;
    },

    dispose() {
      if (!group) return;
      group.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose?.();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else mat?.dispose?.();
      });
      group.removeFromParent();
      group = null;
      points = null;
      drift = null;
      key = null;
    },
  };
}
