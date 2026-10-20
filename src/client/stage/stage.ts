import { effect } from '@preact/signals';
import { player } from '../player';
import { store } from '../store';
import { createEnergySource, type EnergySource } from './analyser';
import { SILENT, proceduralEnergy, type Energy } from './energy';
import {
  degrade,
  loadTier,
  saveTier,
  shouldDegrade,
  TIERS,
  type QualityTier,
} from './quality';
import { themeOrDefault, type ThemeId } from '../../shared/themes';
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
      // 跟着 canvas 自己的盒子走：窄屏时它只占顶部一块，不再铺满视口
      const w = canvas.clientWidth || window.innerWidth;
      const h = canvas.clientHeight || window.innerHeight;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    window.addEventListener('resize', resize);
    // 移动端地址栏收起时窗口不一定触发 resize，但 canvas 的 CSS 高度会变
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(canvas);

    // 订阅房间状态。主题是房间级的，切的时候新旧两个一起在场做交叉淡入淡出
    const { THEME_FACTORIES } = await import('./themes');

    // 查表单独包一层：白名单里只有一个主题时，`if (id === currentId) return`
    // 会把 `id` 窄化成 `never` —— 没有任何取值能落进 else 分支，于是
    // `THEME_FACTORIES[id]` 成了对 `never` 取下标，编译不过。
    // 参数带显式类型就绕开了这个窄化，加第二个主题之后这个坑自己会消失
    const makeTheme = (id: ThemeId) => THEME_FACTORIES[id]();

    // 无障碍：要求减少动态效果时渲染静态场景，播放状态交给现有 UI 表达
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    canvas.dataset.motion = reducedMotion ? 'reduced' : 'full';

    let currentId = themeOrDefault(store.room.value?.theme);
    let current = makeTheme(currentId);
    current.build({ scene, renderer, quality });
    canvas.dataset.theme = currentId;

    let lastTrackId: string | null = null;
    let songBoostUntil = 0;

    this.stopEffects = effect(() => {
      const room = store.room.value;
      const id = themeOrDefault(room?.theme);
      if (id !== currentId) {
        // 切主题：旧的留在场上淡出，新的淡入，过渡结束后才 dispose
        const outgoing = current;
        currentId = id;
        current = makeTheme(id);
        current.build({ scene, renderer, quality });
        current.setWeight(0);
        canvas.dataset.theme = id;
        this.crossFade(outgoing, current);
      }

      const trackId = room?.playback.trackId ?? null;
      if (trackId !== lastTrackId) {
        // 从"没有歌"变成"有歌"也算一次 —— 进房间点第一首时看得见那一下
        songBoostUntil = performance.now() + 900;
        canvas.dataset.transition = 'song';
        lastTrackId = trackId;
      }
    });

    let last = performance.now();
    let lastDebug = 0;

    // 唱片机是房间的恒定中心 —— 它不属于任何主题，切主题时它一直在转
    const { createTurntable, updateTurntable, spin } = await import('./turntable');
    const turntable = createTurntable(THREE, quality);
    turntable.position.y = -0.35;
    scene.add(turntable);

    let angle = 0;

    // 分析链。拿不到就退到程序化曲线 —— 场景永不呆滞，播放永不受影响。
    // AudioContext 必须在用户手势里创建，而播放可能是**对方**发起的，
    // 所以这里挂在第一次 pointerdown 上，一次性。
    let source: EnergySource | null = null;
    let elapsedMs = 0;
    const armAnalyser = () => {
      if (source) return;
      // 这里必须用 player.audio 这个实例，不能 document.querySelector('audio') ——
      // 后者现在能查到（播放器把它挂进了 body），但那是实现细节，
      // 一旦播放器改成不挂载就静默失效：场景照跑，只是永远走兜底曲线
      source = createEnergySource(player.audio);
      removeEventListener('pointerdown', armAnalyser);
    };
    addEventListener('pointerdown', armAnalyser, { once: true });

    // 只看实测帧时间。2 秒滚动窗口，超了就降一档并记住。
    //
    // 只降不升：升档会在临界点上反复横跳，那种抖动比一直低画质更难忍。
    // 档位存在 localStorage，不上行、不进房间状态 —— 画质是设备的事。
    let tier = quality;
    let frames = 0;
    let frameMsSum = 0;
    let windowStart = performance.now();

    const watchQuality = (now: number, dt: number) => {
      frames++;
      frameMsSum += dt;
      if (now - windowStart < 2000) return;
      const avg = frameMsSum / Math.max(1, frames);
      frames = 0;
      frameMsSum = 0;
      windowStart = now;
      // 观测点：手机上没法看控制台，把实测帧时间挂出来
      canvas.dataset.frameMs = avg.toFixed(1);
      if (shouldDegrade(avg) && tier !== 'low') {
        tier = degrade(tier);
        saveTier(tier);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, TIERS[tier].maxPixelRatio));
        canvas.dataset.quality = tier;
      }
    };

    const tick = (now: number) => {
      const dt = Math.min(64, now - last);
      last = now;
      watchQuality(now, dt);

      const playing = store.room.value?.playback.isPlaying ?? false;
      elapsedMs = playing ? elapsedMs + dt : 0;

      // 三层：本地分析 → 程序化兜底。分析失败不影响播放，只是场景节奏感弱一档
      const raw = source?.read(dt) ?? proceduralEnergy(elapsedMs, playing);

      if (songBoostUntil && now >= songBoostUntil) {
        songBoostUntil = 0;
        delete canvas.dataset.transition;
      }
      // 切歌瞬间给一记额外的能量脉冲，粒子会先炸开再聚拢
      const boost = songBoostUntil ? 1 + (songBoostUntil - now) / 900 : 1;
      const energy: Energy =
        boost === 1
          ? raw
          : {
              level: Math.min(1, raw.level * boost),
              bass: Math.min(1, raw.bass * boost),
              treble: Math.min(1, raw.treble * boost),
            };

      // 要求减少动态效果时：唱片不转、能量恒为静默。场景仍在，只是不动
      const motion: Energy = reducedMotion ? SILENT : energy;

      angle = spin(angle, dt, playing && !reducedMotion);
      updateTurntable(turntable, angle, motion, 1);
      current.update(dt, motion);
      renderer.render(scene, camera);

      // 手机上没法看控制台，把状态挂到 DOM 上便于排查。
      // 4 Hz 就够，每帧写属性纯属浪费
      if (now - lastDebug > 250) {
        lastDebug = now;
        canvas.dataset.energy = motion.level.toFixed(2);
      }
    };

    const loop = (now: number) => {
      if (this.disposed) return;
      this.raf = requestAnimationFrame(loop);
      // 锁屏 / 切后台时不该有任何渲染开销
      if (document.hidden) return;
      tick(now);
    };
    this.raf = requestAnimationFrame(loop);

    this.cleanup = () => {
      window.removeEventListener('resize', resize);
      resizeObserver.disconnect();
      removeEventListener('pointerdown', armAnalyser);
      source?.dispose();
      source = null;
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
