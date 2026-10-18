import { useEffect } from 'preact/hooks';
import { CachePanel } from './components/CachePanel';
import { Chat } from './components/Chat';
import { Join } from './components/Join';
import { Library } from './components/Library';
import { Members } from './components/Members';
import { Player } from './components/Player';
import { Queue } from './components/Queue';
import './player'; // 实例化播放器并挂上 store.onPlayback
import { savedName, savedRoom, store } from './store';

export function App() {
  const room = store.room.value;
  const status = store.status.value;

  // 刷新页面后自动回到上次的房间。只在挂载时跑一次。
  useEffect(() => {
    const code = savedRoom();
    const name = savedName();
    if (code && name && !store.room.value) {
      void store.join(code, name).catch(() => {
        // 失败时 store.error 已经有内容，Join 会显示出来
      });
    }
  }, []);

  if (!room) return <Join />;

  return (
    <main class="room">
      <header>
        <strong>房间 {room.code}</strong>
        <span class={`dot ${status}`} title={status} />
        <span class="grow" />
        <button class="icon" title="离开房间" onClick={() => store.leave()}>
          离开
        </button>
      </header>

      {status !== 'open' && (
        <div class="banner">
          {status === 'connecting' ? '正在连接…' : '连接断了，正在重试…'}
        </div>
      )}

      <Player />
      <Library />
      <Queue />
      <Members />
      <Chat />
      <CachePanel />
    </main>
  );
}
