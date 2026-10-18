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
    return <div class="player empty muted">队列里还没有歌。先加一首。</div>;
  }

  const isPlaying = room.playback.isPlaying;

  return (
    <div class="player">
      <div class="title">{track.name}</div>
      <div class="muted small">由 {track.uploaderName} 上传</div>

      <input
        class="seek"
        type="range"
        min={0}
        max={Math.max(duration, 1)}
        value={localTime}
        onInput={(e) => {
          dragging.current = true;
          setLocalTime(Number((e.target as HTMLInputElement).value));
        }}
        onChange={(e) => {
          dragging.current = false;
          store.send({ type: 'seek', positionMs: Number((e.target as HTMLInputElement).value) });
        }}
      />

      <div class="row spread small muted">
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
