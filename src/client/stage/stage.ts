import { effect } from '@preact/signals';
import { store } from '../store';
import { SILENT, type Energy } from './energy';
import { loadTier, TIERS, type QualityTier } from './quality';
import type { ThemeId } from '../../shared/themes';
import type { Theme } from './themes/types';

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

    // 订阅房间状态。主题是房间级的，切的时候新旧两个一起在场做交叉淡入淡出
    const { THEME_FACTORIES } = await import('./themes');
    const { themeOrDefault } = await import('../../shared/themes');

    // 查表单独包一层：白名单里只有一个主题时，`if (id === currentId) return`
    // 会把 `id` 窄化成 `never` —— 没有任何取值能落进 else 分支，于是
    // `THEME_FACTORIES[id]` 成了对 `never` 取下标，编译不过。
    // 参数带显式类型就绕开了这个窄化，加第二个主题之后这个坑自己会消失
    const makeTheme = (id: ThemeId) => THEME_FACTORIES[id]();

    let currentId = themeOrDefault(store.room.value?.theme);
    let current = makeTheme(currentId);
    current.build({ scene, renderer, quality });
    canvas.dataset.theme = currentId;

    this.stopEffects = effect(() => {
      const id = themeOrDefault(store.room.value?.theme);
      if (id === currentId) return;
      // 切主题：旧的留在场上淡出，新的淡入，过渡结束后才 dispose
      const outgoing = current;
      currentId = id;
      current = makeTheme(id);
      current.build({ scene, renderer, quality });
      current.setWeight(0);
      canvas.dataset.theme = id;
      this.crossFade(outgoing, current);
    });

    let last = performance.now();
    let lastDebug = 0;

    const tick = (now: number) => {
      const dt = Math.min(64, now - last);
      last = now;
      current.update(dt, SILENT);
      renderer.render(scene, camera);
    };

    const loop = (now: number) => {
      if (this.disposed) return;
      this.raf = requestAnimationFrame(loop);
      // 锁屏 / 切后台时不该有任何渲染开销
      if (document.hidden) return;
      tick(now);

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
      current.dispose();
      renderer.dispose();
    };

    canvas.dataset.stage = 'ready';
  }

  /** 交叉淡入淡出。**同一时刻最多两个 Theme 存活** —— 过渡结束旧的才 dispose */
  private crossFade(outgoing: Theme, incoming: Theme): void {
    const DURATION = 900;
    const start = performance.now();
    const step = () => {
      const t = Math.min(1, (performance.now() - start) / DURATION);
      incoming.setWeight(t);
      outgoing.setWeight(1 - t);
      if (t < 1 && !this.disposed) {
        requestAnimationFrame(step);
      } else {
        outgoing.dispose();
      }
    };
    requestAnimationFrame(step);
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
