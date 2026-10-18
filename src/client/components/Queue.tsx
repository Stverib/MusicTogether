import { store } from '../store';

export function Queue() {
  const room = store.room.value!;
  const tracks = store.queueTracks.value;
  const currentId = room.playback.trackId;
  const playing = room.playback.isPlaying;

  return (
    <section class="panel queue">
      <h2>队列（{tracks.length}）</h2>
      {tracks.length === 0 && <p class="muted small">空的。</p>}
      <ul class="list">
        {tracks.map((t, i) => (
          <li key={t.id} class={t.id === currentId ? 'current' : ''}>
            <button
              class="link grow"
              title="播放这首"
              onClick={() => store.send({ type: 'play', trackId: t.id })}
            >
              {/* 正在播的那首把序号换成电平条 —— 一眼看出在放哪首 */}
              {t.id === currentId ? (
                <span class={`bars${playing ? ' on' : ''}`} aria-hidden="true">
                  <i />
                  <i />
                  <i />
                  <i />
                </span>
              ) : (
                <span class="idx">{i + 1}</span>
              )}
              {/* Preact 默认转义文本，文件名里的 HTML 不会被解析 */}
              <span class="name">{t.name}</span>
            </button>
            <span class="muted small">{t.uploaderName}</span>
            <button
              class="icon"
              title="从队列移除（云端保留）"
              onClick={() => store.send({ type: 'dequeue', trackId: t.id })}
            >
              ✕
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
