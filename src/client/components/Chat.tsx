import { useEffect, useRef, useState } from 'preact/hooks';
import { store } from '../store';

export function Chat() {
  const [text, setText] = useState('');
  const messages = store.chat.value;
  const total = store.chatTotal.value;
  const loading = store.loadingOlder.value;
  const myName = store.myName.value;
  const listRef = useRef<HTMLUListElement>(null);

  // 是否"贴着底部"。默认贴 —— 刚进房间时应该在最新一条上
  const stick = useRef(true);
  // 点「加载更早」时记下"离底部还有多远"，插入历史后按这个值补回 scrollTop
  const anchor = useRef<number | null>(null);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    if (anchor.current !== null) {
      // 往前插历史：视野要钉在原地，否则会被新内容推着往下跳
      el.scrollTop = el.scrollHeight - anchor.current;
      anchor.current = null;
    } else if (stick.current) {
      // 只在本来就贴着底部时才自动滚。否则你往上翻着看历史，
      // 对方每说一句就把你拽回底部 —— 那是没法读的
      el.scrollTop = el.scrollHeight;
    }
  }, [messages.length]);

  const loadOlder = async () => {
    const el = listRef.current;
    anchor.current = el ? el.scrollHeight - el.scrollTop : null;
    await store.loadOlderChat();
  };

  const older = Math.max(0, total - messages.length);

  return (
    <section class="panel chat">
      <h2>聊天</h2>

      <div class="messages-wrap">
        {older > 0 && (
          <button type="button" class="load-older" disabled={loading} onClick={() => void loadOlder()}>
            {loading ? '加载中…' : `加载更早的 ${older} 条`}
          </button>
        )}
        <ul class="messages" ref={listRef} onScroll={onScroll}>
          {messages.length === 0 && <li class="muted small">还没有人说话。</li>}
          {messages.map((m) => (
            // 用消息自己的 id 当 key，不用下标 —— 往前插历史时下标全会错位
            <li key={m.id} class={m.name === myName ? 'mine' : ''}>
              <span class="who">{m.name}</span>
              {/* 绝不用 innerHTML —— 消息是攻击者可控的，靠 Preact 的默认转义 */}
              <span class="what">{m.text}</span>
            </li>
          ))}
        </ul>
      </div>

      <form
        class="row"
        onSubmit={(e) => {
          e.preventDefault();
          const t = text.trim();
          if (!t) return;
          store.send({ type: 'chat', text: t });
          setText('');
        }}
      >
        <input
          class="grow"
          value={text}
          onInput={(e) => setText((e.target as HTMLInputElement).value)}
          placeholder="说点什么…"
          maxLength={500}
        />
        <button type="submit" disabled={!text.trim()}>
          发送
        </button>
      </form>
    </section>
  );
}
