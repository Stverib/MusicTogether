import { useEffect, useRef, useState } from 'preact/hooks';
import { store } from '../store';

export function Chat() {
  const [text, setText] = useState('');
  const messages = store.chat.value;
  const myName = store.myName.value;
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  return (
    <section class="panel chat">
      <h2>聊天</h2>

      <ul class="messages" ref={listRef}>
        {messages.length === 0 && <li class="muted small">还没有人说话。</li>}
        {messages.map((m, i) => (
          <li key={i} class={m.name === myName ? 'mine' : ''}>
            <span class="who">{m.name}</span>
            {/* 绝不用 innerHTML —— 消息是攻击者可控的，靠 Preact 的默认转义 */}
            <span class="what">{m.text}</span>
          </li>
        ))}
      </ul>

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
