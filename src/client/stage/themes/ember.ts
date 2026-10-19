import * as THREE from 'three';
import type { Energy } from '../energy';
import type { QualityTier } from '../quality';
import type { Theme, ThemeContext } from './types';

/** 余烬：深底 + 暖橙线框球 + 亮核。参考图见设计规格 §8.1 */
export const EMBER = {
  deep: 0x150b07,
  warm: 0xff5a1e,
  core: 0xffd9b0,
} as const;

/** 球的细分。越低越省，low 那颗也已经看得出是个球 */
const DETAIL: Record<QualityTier, number> = { high: 3, medium: 2, low: 1 };

const PARTICLES: Record<QualityTier, number> = { high: 900, medium: 360, low: 120 };

/** 球的基准半径。唱片机在球心，半径 1.15 —— 球要把它整个罩住 */
const RADIUS = 1.6;

/** 扰动幅度。低音会把它顶上去，见 update() */
const WOBBLE = 0.16;

/**
 * 径向渐变贴图，用来做光晕。
 *
 * 参考图那种辉光是 bloom 的典型效果，而 bloom 在手机上是性能杀手，
 * 跟"一起听歌时手机不能烫"直接冲突。这里用**加法混合的渐变贴图**替代：
 * 观感接近，代价是几个 draw call，一行后期处理都不写。
 */
function glowTexture(): THREE.Texture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255, 217, 176, 0.95)');
  g.addColorStop(0.35, 'rgba(255, 90, 30, 0.45)');
  g.addColorStop(1, 'rgba(255, 90, 30, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function createEmberTheme(): Theme {
  let group: THREE.Group | null = null;
  let wire: THREE.Mesh | null = null;
  let halo: THREE.Sprite | null = null;
  let core: THREE.Mesh | null = null;
  let points: THREE.Points | null = null;
  let base: Float32Array | null = null;
  let weight = 1;

  return {
    build(ctx: ThemeContext) {
      const scene = ctx.scene;
      scene.background = new THREE.Color(EMBER.deep);
      scene.fog = new THREE.Fog(EMBER.deep, 8, 26);

      group = new THREE.Group();

      // 线框球。用 Mesh + wireframe 而不是 WireframeGeometry ——
      // 后者是另建一份几何体，顶点一动就对不上了；前者直接画这份几何体的边，
      // 所以每帧改顶点它就跟着动，而且只有一次 draw call
      const geo = new THREE.IcosahedronGeometry(RADIUS, DETAIL[ctx.quality]);
      const pos = geo.getAttribute('position') as THREE.BufferAttribute;
      const arr = pos.array as Float32Array;
      // 存**单位方向**而不是坐标：扰动按方向算，相邻三角形共享同一个方向就拿到
      // 同一个位移，球面才不会裂成碎片（IcosahedronGeometry 是非索引的，
      // 每个三角形各有一份顶点）
      base = new Float32Array(arr.length);
      for (let i = 0; i < arr.length; i += 3) {
        const x = arr[i]!;
        const y = arr[i + 1]!;
        const z = arr[i + 2]!;
        const len = Math.hypot(x, y, z) || 1;
        base[i] = x / len;
        base[i + 1] = y / len;
        base[i + 2] = z / len;
      }

      wire = new THREE.Mesh(
        geo,
        new THREE.MeshBasicMaterial({
          color: EMBER.warm,
          wireframe: true,
          // 双面：只画正面的话只能看见近半个球，参考图里那种密网就没有了
          side: THREE.DoubleSide,
          transparent: true,
          opacity: 0.85,
          depthWrite: false,
        }),
      );
      wire.renderOrder = 2;
      group.add(wire);

      // 亮核。也是加法混合 —— 它不是"挡住"球心那台唱片机，而是给它镀一层光
      core = new THREE.Mesh(
        new THREE.IcosahedronGeometry(0.55, 1),
        new THREE.MeshBasicMaterial({
          color: EMBER.core,
          transparent: true,
          opacity: 0.95,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      core.renderOrder = 1;
      group.add(core);

      // 光晕：加法混合的径向渐变。画在最底下 —— 它是背景光，不是一层壳
      halo = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: glowTexture(),
          color: EMBER.warm,
          transparent: true,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      halo.scale.setScalar(9);
      halo.renderOrder = 0;
      group.add(halo);

      // 微粒：绕球公转
      const count = PARTICLES[ctx.quality];
      const p = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        const r = 2.4 + Math.random() * 4;
        const a = Math.random() * Math.PI * 2;
        p[i * 3] = Math.cos(a) * r;
        p[i * 3 + 1] = (Math.random() - 0.5) * 4;
        p[i * 3 + 2] = Math.sin(a) * r;
      }
      const pgeo = new THREE.BufferGeometry();
      pgeo.setAttribute('position', new THREE.BufferAttribute(p, 3));
      points = new THREE.Points(
        pgeo,
        new THREE.PointsMaterial({
          color: EMBER.warm,
          size: 0.05,
          transparent: true,
          opacity: 0.7,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      group.add(points);
      points.renderOrder = 3;

      // 球心一盏光，把唱片机从球里照亮
      const light = new THREE.PointLight(EMBER.warm, 14, 16, 2);
      light.position.set(0, 0.6, 0.8);
      group.add(light);
      group.add(new THREE.AmbientLight(EMBER.warm, 0.35));

      scene.add(group);
    },

    update(dtMs: number, energy: Energy) {
      if (!wire || !halo || !core || !points || !base) return;
      const t = performance.now() / 1000;

      // 顶点扰动。低音把它顶起来，球于是随鼓点起伏
      const amp = WOBBLE * (1 + energy.bass * 2.2) * weight;
      const pos = wire.geometry.getAttribute('position') as THREE.BufferAttribute;
      const arr = pos.array as Float32Array;
      for (let i = 0; i < base.length; i += 3) {
        const x = base[i]!;
        const y = base[i + 1]!;
        const z = base[i + 2]!;
        // 只看方向，不看顶点序号 —— 同一个方向永远拿到同一个位移，球面不裂
        const d =
          Math.sin(y * 3.1 + t * 1.3) * Math.cos(x * 2.3 + t * 0.7) +
          Math.sin(z * 4.1 - t * 0.9);
        const r = RADIUS * (1 + amp * d);
        arr[i] = x * r;
        arr[i + 1] = y * r;
        arr[i + 2] = z * r;
      }
      pos.needsUpdate = true;

      // 线框与光晕的亮度跟高音走，低音把光晕撑开
      (wire.material as THREE.MeshBasicMaterial).opacity = (0.5 + energy.treble * 0.45) * weight;
      (halo.material as THREE.SpriteMaterial).opacity = (0.35 + energy.level * 0.55) * weight;
      halo.scale.setScalar((8 + energy.bass * 3) * (0.85 + weight * 0.15));
      (core.material as THREE.MeshBasicMaterial).opacity = (0.7 + energy.level * 0.3) * weight;

      // 微粒缓慢公转
      points.rotation.y += dtMs * 0.00004;
      (points.material as THREE.PointsMaterial).opacity = (0.3 + energy.treble * 0.5) * weight;

      // 球本身极慢地自转，免得扰动看着像静止的
      if (wire.parent) wire.parent.rotation.y = t * 0.08;
    },

    setWeight(w: number) {
      weight = w;
      if (group) group.visible = w > 0.001;
    },

    dispose() {
      if (!group) return;
      group.traverse((o) => {
        const any = o as THREE.Mesh & { material?: THREE.Material | THREE.Material[] };
        any.geometry?.dispose?.();
        const mat = any.material;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else {
          (mat as THREE.SpriteMaterial | undefined)?.map?.dispose();
          mat?.dispose?.();
        }
      });
      group.removeFromParent();
      group = null;
      wire = null;
      halo = null;
      core = null;
      points = null;
      base = null;
    },
  };
}
