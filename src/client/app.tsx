import { useEffect, useRef, useState } from 'preact/hooks';
import { CachePanel } from './components/CachePanel';
import { Chat } from './components/Chat';
import { Join } from './components/Join';
import { Library } from './components/Library';
import { Members } from './components/Members';
import { Player } from './components/Player';
import { Queue } from './components/Queue';
import './player'; // 实例化播放器并挂上 store.onPlayback
import { codeFromUrl, roomLink, shareRoom } from './share';
import { THEME_IDS, type ThemeId } from '../shared/themes';
import { savedName, savedRoom, store } from './store';

/** 主题的中文名。加主题时在这里补一行 */
const THEME_NAMES: Record<ThemeId, string> = { dawn: '晨光', ember: '余烬' };

export function App() {
  const room = store.room.value;
  const status = store.status.value;
  const inRoom = room !== null;

  // 分享链接里的房间码只在挂载时读一次。加入之后地址栏会被还原成 /，
  // 要是每次渲染都读，就会把已经清掉的码又读回来。
  const [linkedCode] = useState(() => codeFromUrl(location.pathname, location.search));
  const [note, setNote] = useState<string | null>(null);
  const noteTimer = useRef<number | null>(null);

  const say = (msg: string) => {
    setNote(msg);
    if (noteTimer.current) clearTimeout(noteTimer.current);
    noteTimer.current = window.setTimeout(() => setNote(null), 3200);
  };

  // 刷新页面后自动回到上次的房间。只在挂载时跑一次。
  useEffect(() => {
    const name = savedName();
    // 分享链接优先于「上次待过的房间」—— 别人刚把你拉进一个新房间
    const code = linkedCode ?? savedRoom();
    if (code && name && !store.room.value) {
      void store.join(code, name).catch(() => {
        // 失败时 store.error 已经有内容，Join 会显示出来
      });
    }
  }, []);

  // 场景只在房间里存在。整棵场景树（stage + 画质 + 律动 + 主题）走**动态
  // import** —— 首屏一个字节都不背它，进房间之后才拉一个 chunk 下来。
  //
  // 依赖是一个布尔值而不是 room 本身：后者每次快照更新都是新对象，
  // 会把场景反复拆了重建。
  useEffect(() => {
    if (!inRoom) return;
    let cancelled = false;
    let mounted: { unmount(): void } | null = null;
    void import('./stage/stage').then((m) => {
      // 还没拉下来就已经离开房间了，那就别挂
      if (cancelled) return;
      mounted = m.stage;
      m.stage.mount();
    });
    return () => {
      cancelled = true;
      mounted?.unmount();
    };
  }, [inRoom]);

  if (!room) return <Join initialCode={linkedCode ?? ''} />;

  const onShare = async () => {
    const outcome = await shareRoom(room.code);
    if (outcome === 'shared') say('已分享');
    else if (outcome === 'copied') say('链接已复制，发给对方就能进来');
    // 兜底路径：把链接显示出来让人手动复制，不然这个按钮在
    // 局域网 HTTP 下就是个哑巴
    else say(`复制失败，请手动复制：${roomLink(room.code)}`);
  };

  return (
    <main class="room">
      <header>
        {/* 房间码单独包一层好上等宽字体。textContent 仍是「房间 XXXX」，
            测试与复制行为都不变 */}
        <strong>
          房间 <span class="code">{room.code}</span>
        </strong>
        <span class={`dot ${status}`} title={status} />
        <span class="grow" />
        {/* 只有一个主题时切换器没有意义，不渲染 —— 别摆一个点了没反应的按钮 */}
        {THEME_IDS.length > 1 && (
          <div class="theme-switch">
            {THEME_IDS.map((id) => (
              <button
                key={id}
                class={id === room.theme ? 'on' : ''}
                title={`切换到${THEME_NAMES[id]}`}
                onClick={() => store.setTheme(id)}
              >
                {THEME_NAMES[id]}
              </button>
            ))}
          </div>
        )}
        <button class="icon" title="分享房间" onClick={() => void onShare()}>
          分享
        </button>
        <button class="icon" title="离开房间" onClick={() => store.leave()}>
          离开
        </button>
      </header>

      {status !== 'open' && (
        <div class="banner">
          {status === 'connecting' ? '正在连接…' : '连接断了，正在重试…'}
        </div>
      )}

      {/* 宽屏两列：左边是"在听什么"，右边是"和谁、在聊什么" */}
      <div class="layout">
        <div class="col">
          <Player />
          <Library />
          <Queue />
        </div>
        <div class="col">
          <Members />
          <Chat />
          <CachePanel />
        </div>
      </div>

      {note && <div class="toast">{note}</div>}
    </main>
  );
}
