import { effect } from '@preact/signals';
import { store } from '../store';
import { SILENT, type Energy } from './energy';
import { loadTier, TIERS, type QualityTier } from './quality';

/**
 * 场景层。
 *
 * 与 `player.ts` 同一个模式：**独立模块 + 自己订阅 store**，不活在 Preact
 * 组件树里。3D 是每帧渲染，Preact 是每次状态变化渲染，两者混进同一个调度器
 * 会出难查的抖动。
 *
 * 这个文件的**静态 import 里没有 three** —— three 由 `boot()` 动态 import。
 * 否则那 150 KB（gzip 后）会跟着首屏一起下来。
 *
 * 三条降级路径，任何一条生效都不影响播放与房间功能：
 *   1. 拿不到 WebGL context  → 不挂载
 *   2. import('three') 失败  → 不挂载
 *   3. 运行期抛异常          → 卸载并安静收场
 */
class Stage {
  private booted = false;
  private bootPending = false;
  private disposed = false;
  private canvas: HTMLCanvasElement | null = null;
  private raf = 0;
  private cleanup: (() => void) | null = null;
  private stopEffects: (() => void) | null = null;

  mount(): void {
    if (this.booted || this.bootPending) return;
    this.disposed = false;
    this.bootPending = true;
    void this.boot()
      .catch(() => this.teardown())
      .finally(() => {
        this.bootPending = false;
      });
  }

  unmount(): void {
    this.disposed = true;
    this.teardown();
  }

  private async boot(): Promise<void> {
    // 先 import 再建 canvas：拉不下来就什么都不用收尾
    const THREE = await import('three');
    if (this.disposed) return;

    const canvas = document.createElement('canvas');
    canvas.className = 'stage-canvas';
    // 纯装饰：读屏软件跳过它，也不接收指针事件
    canvas.setAttribute('aria-hidden', 'true');

    // three 会自己再要一次 context，这里先要一次来判断可用性；
    // 拿不到就整个不挂载，页面行为与没有场景时一模一样
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    if (!gl) return;

    document.body.appendChild(canvas);
    this.canvas = canvas;
    this.booted = true;

    const quality = loadTier();
    canvas.dataset.quality = quality;

    const renderer = new THREE.WebGLRenderer({ canvas, context: gl, antialias: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, TIERS[quality].maxPixelRatio));

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    camera.position.set(0, 1.6, 4.2);
    camera.lookAt(0, 0, 0);

    const resize = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    window.addEventListener('resize', resize);

    // 订阅房间状态。这一版只是把订阅接通，主题在 Task 4 接上
    this.stopEffects = effect(() => {
      void store.room.value;
    });

    let last = performance.now();
    let lastDebug = 0;

    const loop = (now: number) => {
      if (this.disposed) return;
      this.raf = requestAnimationFrame(loop);
      // 锁屏 / 切后台时不该有任何渲染开销
      if (document.hidden) return;
      last = now;
      renderer.render(scene, camera);

      // 手机上没法看控制台，把状态挂到 DOM 上便于排查。
      // 4 Hz 就够，每帧写属性纯属浪费
      if (now - lastDebug > 250) {
        lastDebug = now;
        canvas.dataset.energy = '0.00';
      }
    };
    this.raf = requestAnimationFrame(loop);

    this.cleanup = () => {
      window.removeEventListener('resize', resize);
      this.stopEffects?.();
      this.stopEffects = null;
      renderer.dispose();
    };

    canvas.dataset.stage = 'ready';
  }

  private teardown(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    try {
      this.cleanup?.();
    } catch {
      // 收尾失败也不能往外抛
    }
    this.cleanup = null;
    this.canvas?.remove();
    this.canvas = null;
    this.booted = false;
  }
}

export const stage = new Stage();

/** 让别的模块能引用到这些类型而不必再 import 一次 */
export type { Energy, QualityTier };
export { SILENT };
