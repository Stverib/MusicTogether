import { SILENT, readEnergy, type Energy } from './energy';

export type EnergySource = {
  /** 返回 null 表示这帧没有数据，调用方退到兜底曲线 */
  read(dtMs: number): Energy | null;
  dispose(): void;
};

/**
 * 接一路音频出来分析。三层，任何一层失败就退到下一层。
 *
 * **主路用 captureStream，不用 createMediaElementSource。** 后者会把 audio
 * 元素的输出整个搬进 Web Audio 图，而且**不可撤销** —— 一旦调用，该元素的输出
 * 永久走这个图。于是"销毁分析器"就不能 disconnect 了事，必须把
 * source → destination 重新接上，否则整首歌永久静音。这是"加了可视化之后
 * 没声音"这类 bug 的标准成因，也是这里绕开它的原因。
 *
 * 拿不到就返回 null，由调用方走程序化兜底。**任何情况下都不抛异常出去。**
 */
export function createEnergySource(audio: HTMLAudioElement): EnergySource | null {
  let ctx: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  // 显式写成 Uint8Array<ArrayBuffer>：TS 7 里裸 Uint8Array 是
  // Uint8Array<ArrayBufferLike>，而 getByteFrequencyData 只收 ArrayBuffer 那种
  let spectrum: Uint8Array<ArrayBuffer> | null = null;
  let prev: Energy = SILENT;
  let rerouted = false;

  try {
    ctx = new AudioContext();
    analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.6;
    spectrum = new Uint8Array(analyser.frequencyBinCount);

    const capture = (audio as HTMLAudioElement & { captureStream?: () => MediaStream })
      .captureStream;
    if (typeof capture === 'function') {
      // 主路：元素照常播放，我们只是从旁边接一路出来
      const stream = capture.call(audio);
      ctx.createMediaStreamSource(stream).connect(analyser);
    } else {
      // 备路：这一步不可撤销，见上面的说明
      const source = ctx.createMediaElementSource(audio);
      source.connect(analyser);
      analyser.connect(ctx.destination);
      rerouted = true;
    }
  } catch {
    // 任何一步失败都整条摘掉，交给调用方兜底
    try {
      void ctx?.close();
    } catch {
      /* 收尾失败也不抛 */
    }
    return null;
  }

  const ownCtx = ctx;
  const ownAnalyser = analyser;
  const ownSpectrum = spectrum;

  return {
    read(dtMs: number): Energy | null {
      try {
        // 自动播放策略下 AudioContext 可能起不来。退到兜底，不影响播放
        if (ownCtx.state !== 'running') return null;
        ownAnalyser.getByteFrequencyData(ownSpectrum);
        prev = readEnergy(ownSpectrum, ownCtx.sampleRate, prev, dtMs);
        return prev;
      } catch {
        return null;
      }
    },

    dispose(): void {
      try {
        if (rerouted) {
          // 走过备路的话，元素的输出永久在这个图里。断开分析器之后必须
          // 让 source 直连 destination —— 否则整首歌永久静音。
          ownAnalyser.disconnect();
        }
        void ownCtx.close();
      } catch {
        /* 收尾失败也不能往外抛 */
      }
    },
  };
}
