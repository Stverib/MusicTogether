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

/** 分频段。低音驱动粒子的推挤与光晕，高音驱动闪烁 */
const BASS_HZ: [number, number] = [20, 250];
const TREBLE_HZ: [number, number] = [4000, 16000];

/** 攻击快、释放慢。不这么做的话粒子会随每一个鼓点抖成噪声 */
const ATTACK_MS = 80;
const RELEASE_MS = 400;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** 一个频段对应到 FFT 的哪些 bin。bin 宽度 = sampleRate / 2 / binCount */
function bandRange(sampleRate: number, binCount: number, [lo, hi]: [number, number]) {
  const hzPerBin = sampleRate / 2 / binCount;
  const from = Math.max(1, Math.floor(lo / hzPerBin));
  const to = Math.min(binCount - 1, Math.ceil(hi / hzPerBin));
  return { from, to: Math.max(from + 1, to) };
}

function bandLevel(spectrum: Uint8Array, sampleRate: number, band: [number, number]): number {
  const { from, to } = bandRange(sampleRate, spectrum.length, band);
  let sum = 0;
  for (let i = from; i < to; i++) sum += spectrum[i] ?? 0;
  // 255 是满幅。开方是为了让弱信号也看得见，否则安静段落场景是死的
  return clamp01(Math.sqrt(sum / (to - from) / 255));
}

function smooth(prev: number, next: number, dtMs: number): number {
  const ms = next > prev ? ATTACK_MS : RELEASE_MS;
  const k = clamp01(dtMs / ms);
  return prev + (next - prev) * k;
}

/**
 * 从一帧频谱里读出能量。纯函数，不碰 DOM，所以能在 node 里测。
 */
export function readEnergy(
  spectrum: Uint8Array,
  sampleRate: number,
  prev: Energy,
  dtMs: number,
): Energy {
  let sum = 0;
  for (let i = 0; i < spectrum.length; i++) sum += spectrum[i] ?? 0;
  const rawLevel = clamp01(Math.sqrt(sum / spectrum.length / 255));

  const raw: Energy = {
    level: rawLevel,
    bass: bandLevel(spectrum, sampleRate, BASS_HZ),
    treble: bandLevel(spectrum, sampleRate, TREBLE_HZ),
  };

  return {
    level: smooth(prev.level, raw.level, dtMs),
    bass: smooth(prev.bass, raw.bass, dtMs),
    treble: smooth(prev.treble, raw.treble, dtMs),
  };
}

/**
 * 兜底曲线：拿不到任何频域数据时用。
 *
 * 按播放时间推一条缓慢起伏的假能量。场景永不呆滞，节奏感弱一档，
 * 但它绝不出错 —— 这是"可视化不能反过来弄坏播放"这条底线的最后一层。
 */
export function proceduralEnergy(elapsedMs: number, playing: boolean): Energy {
  if (!playing) return SILENT;
  const t = elapsedMs / 1000;
  const a = 0.5 + 0.5 * Math.sin(t * 0.7);
  const b = 0.5 + 0.5 * Math.sin(t * 1.9 + 1.1);
  const c = 0.5 + 0.5 * Math.sin(t * 3.3 + 2.4);
  return {
    level: clamp01(0.28 + a * 0.24),
    bass: clamp01(0.2 + b * 0.3),
    treble: clamp01(0.15 + c * 0.35),
  };
}
