import type { Energy } from './energy';
import type { QualityTier } from './quality';

/** 比真实的 33⅓ rpm 慢得多 —— 看得出在转就够了，快了反而晃眼 */
const RADIANS_PER_SECOND = 0.9;

/** 单帧最多推进这么多毫秒。切后台回来时 dt 可能是好几分钟 */
const MAX_STEP_MS = 64;

/**
 * 唱盘转角。纯函数，所以能在 node 里测。
 *
 * 夹住单帧步长是必须的：标签页被挂起时 `requestAnimationFrame` 的时间差
 * 可能是几分钟，不夹的话回到前台会看到唱片"啪"地跳好几圈。
 */
export function spin(angle: number, dtMs: number, playing: boolean): number {
  if (!playing) return angle;
  const step = Math.min(MAX_STEP_MS, Math.max(0, dtMs));
  const next = angle + (RADIANS_PER_SECOND * step) / 1000;
  return next % (Math.PI * 2);
}

/**
 * 黑胶唱片机。**它不属于任何主题** —— 它是房间的恒定中心，由 Stage 持有，
 * 所以切主题时它一直在转，不会被重建。
 *
 * `THREE` 从参数传进来而不是 `import * as THREE`：这个文件被 stage.ts 静态
 * 引用，顶层 import three 会把那 700 KB 拖进首屏。
 */
export function createTurntable(
  THREE: typeof import('three'),
  quality: QualityTier,
): import('three').Group {
  const segments = quality === 'low' ? 24 : 64;
  const group = new THREE.Group();

  // 转盘
  const platter = new THREE.Mesh(
    new THREE.CylinderGeometry(1.15, 1.15, 0.08, segments),
    new THREE.MeshStandardMaterial({ color: 0x8fa89a, roughness: 0.5, metalness: 0.3 }),
  );
  group.add(platter);

  // 唱片
  const disc = new THREE.Mesh(
    new THREE.CylinderGeometry(1.0, 1.0, 0.02, segments),
    new THREE.MeshStandardMaterial({ color: 0x2b2320, roughness: 0.35, metalness: 0.1 }),
  );
  disc.position.y = 0.05;
  disc.name = 'disc';
  group.add(disc);

  // 标签
  const label = new THREE.Mesh(
    new THREE.CylinderGeometry(0.3, 0.3, 0.021, segments),
    new THREE.MeshStandardMaterial({ color: 0xf2a172, roughness: 0.6 }),
  );
  label.position.y = 0.052;
  disc.add(label);

  // 唱臂：细长一根，斜搭在唱片上
  const arm = new THREE.Mesh(
    new THREE.CylinderGeometry(0.02, 0.02, 1.5, 12),
    new THREE.MeshStandardMaterial({ color: 0x8fa89a, roughness: 0.3, metalness: 0.6 }),
  );
  arm.position.set(0.95, 0.28, 0.35);
  arm.rotation.z = -0.55;
  group.add(arm);

  return group;
}

export function updateTurntable(
  group: import('three').Group,
  angle: number,
  energy: Energy,
  weight: number,
): void {
  const disc = group.getObjectByName('disc');
  if (!disc) return;
  disc.rotation.y = angle;
  // 低音给整台机器一点极轻的呼吸，别太明显
  const scale = 1 + energy.bass * 0.02 * weight;
  group.scale.setScalar(scale);
}
