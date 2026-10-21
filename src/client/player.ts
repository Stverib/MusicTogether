import { RESYNC_THRESHOLD_MS, positionAt, shouldResync } from '../shared/playback';
import type { Playback } from '../shared/types';
import { cacheTrack, getCachedUrl } from './cache';
import { store } from './store';
import { planPlayback, streamUrl } from './sync';

/**
 * 起播可能比锚点晚（主线程忙时能到一秒以上），而周期校偏的阈值是 2 秒，
 * 会留下一个接近 2 秒的固定偏差。起播时用更紧的阈值单独对齐一次。
 */
const START_ALIGN_MS = 500;

/**
 * 起播时先别抢带宽：整首缓存和 <audio> 走同一条网络，
 * 窄带下同时下载会让进度条卡在 0:00 很久。等播放稳定后再缓存。
 */
const CACHE_DELAY_MS = 12_000;
const CACHE_RETRY_MS = 5_000;

/**
 * 同步播放器。
 *
 * 职责只有一个：收到服务端锚点后，把 <audio> 摆到正确的位置。
 * 判断逻辑在 sync.ts 的 planPlayback 里，这里只负责执行与状态维护。
 */
export class Player {
  readonly audio: HTMLAudioElement;

  private currentTrackId: string | null = null;
  private cacheTimer: number | null = null;
  private lastServerNow = 0;
  private lastReceivedAt = 0;

  constructor() {
    this.audio = new Audio();
    this.audio.preload = 'auto';
    // 挂进 DOM 而不是让它游离在外：在 DOM 里的媒体元素在后台播放与
    // Media Session 上更可靠，也便于调试与 E2E 读取真实状态。
    this.audio.hidden = true;
    document.body.appendChild(this.audio);

    this.audio.addEventListener('timeupdate', () => this.correctDrift());
    this.audio.addEventListener('playing', () => {
      store.playError.value = null;
      this.correctDrift(START_ALIGN_MS);
    });
    this.audio.addEventListener('ended', () => store.send({ type: 'next' }));
    this.audio.addEventListener('error', () => {
      if (!this.currentTrackId) return;
      this.clearCacheTimer();
      const code = this.audio.error?.code;
      console.warn('播放失败', code, this.currentTrackId);
      // 3 = 解码失败，4 = 源不受支持。其余多半是网络或解码器临时问题
      store.playError.value =
        code === 3 || code === 4
          ? '这首歌无法播放：文件损坏、编码不受支持，或里面没有音频轨道。'
          : '这首歌播放出错了，换一首试试。';
    });

    store.onPlayback = (playback, serverNow, align) => this.apply(playback, serverNow, align);
    this.setupMediaSession();
  }

  /** 播放过程中的持续校偏。默认阈值 2 秒；起播时传入更紧的阈值。 */
  private correctDrift(thresholdMs = RESYNC_THRESHOLD_MS): void {
    const playback = store.room.value?.playback;
    if (!playback?.isPlaying || !this.lastServerNow) return;

    const elapsed = performance.now() - this.lastReceivedAt;
    const target = positionAt(playback, this.lastServerNow + elapsed);
    if (shouldResync(this.audio.currentTime * 1000, target, thresholdMs)) {
      this.audio.currentTime = target / 1000;
    }
  }

  /** `align` 用于进房/重连的权威快照：偏差容忍度收紧到 500ms */
  apply(playback: Playback, serverNow: number, align = false): void {
    this.lastServerNow = serverNow;
    this.lastReceivedAt = performance.now();

    const plan = planPlayback(
      { trackId: this.currentTrackId, currentTime: this.audio.currentTime },
      playback,
      serverNow,
      align ? START_ALIGN_MS : RESYNC_THRESHOLD_MS,
    );

    if (plan.action === 'load') {
      this.load(playback, plan.positionMs, plan.isPlaying);
      return;
    }

    if (plan.action === 'seek') {
      this.audio.currentTime = plan.positionMs / 1000;
    }

    if (plan.isPlaying && this.audio.paused) {
      void this.audio.play().catch(() => {});
    } else if (!plan.isPlaying && !this.audio.paused) {
      this.audio.pause();
    }
  }

  private clearCacheTimer(): void {
    if (this.cacheTimer !== null) {
      window.clearTimeout(this.cacheTimer);
      this.cacheTimer = null;
    }
  }

  /**
   * 缓存是离线的锦上添花，不该拖慢正在进行的播放：
   * 先等 12 秒；如果还在缓冲，就一轮轮往后推，直到真的有足够数据。
   */
  private scheduleCache(trackId: string, url: string, delay: number): void {
    this.clearCacheTimer();
    this.cacheTimer = window.setTimeout(() => {
      this.cacheTimer = null;
      if (this.currentTrackId !== trackId) return; // 期间切歌了
      if (this.audio.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) {
        this.scheduleCache(trackId, url, CACHE_RETRY_MS);
        return;
      }
      void cacheTrack(trackId, url).catch(() => {
        // 缓存失败不影响播放，只是下次还得走网络
      });
    }, delay);
  }

  private load(playback: Playback, positionMs: number, isPlaying: boolean): void {
    const room = store.room.value;
    const trackId = playback.trackId;
    this.currentTrackId = trackId;
    this.clearCacheTimer();
    store.playError.value = null;

    if (!room || !trackId) {
      this.audio.removeAttribute('src');
      this.audio.load();
      return;
    }

    const networkUrl = streamUrl(room.code, trackId);

    void (async () => {
      // 有本地缓存就秒开且离线可用；没有就走网络流，起播稳定后再缓存
      const local = await getCachedUrl(trackId);
      if (this.currentTrackId !== trackId) return; // 期间切歌了，这次加载作废

      this.audio.src = local ?? networkUrl;
      this.audio.currentTime = positionMs / 1000;
      if (isPlaying) void this.audio.play().catch(() => {});

      if (!local) this.scheduleCache(trackId, networkUrl, CACHE_DELAY_MS);
    })();
  }

  private setupMediaSession(): void {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;

    ms.setActionHandler('play', () => store.send({ type: 'resume' }));
    ms.setActionHandler('pause', () => store.send({ type: 'pause' }));
    ms.setActionHandler('nexttrack', () => store.send({ type: 'next' }));
    ms.setActionHandler('previoustrack', () => store.send({ type: 'prev' }));
    ms.setActionHandler('seekto', (details) => {
      if (typeof details.seekTime === 'number') {
        store.send({ type: 'seek', positionMs: details.seekTime * 1000 });
      }
    });

    let lastTrackId: string | null = null;
    setInterval(() => {
      const track = store.currentTrack.value;
      if (!track || track.id === lastTrackId) return;
      lastTrackId = track.id;
      ms.metadata = new MediaMetadata({
        title: track.name,
        artist: `由 ${track.uploaderName} 上传`,
        album: 'MusicTogether',
      });
    }, 1000);
  }
}

export const player = new Player();
