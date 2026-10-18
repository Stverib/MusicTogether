import { useEffect, useRef, useState } from 'preact/hooks';
import { player } from '../player';
import { store } from '../store';

function fmt(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export function Player() {
  const room = store.room.value!;
  const track = store.currentTrack.value;
  const [localTime, setLocalTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const dragging = useRef(false);

  useEffect(() => {
    const id = setInterval(() => {
      if (!dragging.current) setLocalTime(player.audio.currentTime * 1000);
      const d = player.audio.duration;
      setDuration(Number.isFinite(d) ? d * 1000 : 0);
    }, 250);
    return () => clearInterval(id);
  }, []);

  if (!track) {
    // 「队列里有歌」和「正在放歌」是两回事 —— 上传只入队，不自动开播
    const first = store.queueTracks.value[0];
    return (
      <div class="player empty">
        {first ? (
          <>
            <div class="muted">还没有在放的歌。</div>
            <button
              class="primary"
              onClick={() => store.send({ type: 'play', trackId: first.id })}
            >
              播放《{first.name}》
            </button>
          </>
        ) : (
          <div class="muted">队列里还没有歌。先加一首。</div>
        )}
      </div>
    );
  }

  const isPlaying = room.playback.isPlaying;
  // 进度条的填充比例。用 CSS 变量交给样式表画那道"光"。
  const pct = duration > 0 ? Math.min(100, Math.max(0, (localTime / duration) * 100)) : 0;

  return (
    <div class="player">
      <div class="eyebrow">
        <span class="pip" />
        {isPlaying ? '正在播放' : '已暂停'}
      </div>

      <div class="title">{track.name}</div>
      <div class="by">由 {track.uploaderName} 上传</div>

      <input
        class="seek"
        type="range"
        min={0}
        max={Math.max(duration, 1)}
        value={localTime}
        // 进度条的填充比例交给样式表画。用 style 字符串而不是对象 ——
        // Preact 的对象式 style 类型里没有自定义属性
        style={`--p:${pct}%`}
        onInput={(e) => {
          dragging.current = true;
          setLocalTime(Number((e.target as HTMLInputElement).value));
        }}
        onChange={(e) => {
          dragging.current = false;
          store.send({ type: 'seek', positionMs: Number((e.target as HTMLInputElement).value) });
        }}
      />

      <div class="row spread times">
        <span>{fmt(localTime)}</span>
        <span>{fmt(duration)}</span>
      </div>

      <div class="row controls">
        <button title="上一首" onClick={() => store.send({ type: 'prev' })}>
          ⏮
        </button>
        <button
          class="primary"
          title={isPlaying ? '暂停' : '播放'}
          onClick={() => store.send({ type: isPlaying ? 'pause' : 'resume' })}
        >
          {isPlaying ? '⏸' : '▶'}
        </button>
        <button title="下一首" onClick={() => store.send({ type: 'next' })}>
          ⏭
        </button>
      </div>
    </div>
  );
}
