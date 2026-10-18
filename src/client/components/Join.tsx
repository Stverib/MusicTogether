import { useState } from 'preact/hooks';
import { normalizeCode } from '../../shared/codes';
import { getOrCreateClientId, store } from '../store';

export function Join({ initialCode = '' }: { initialCode?: string }) {
  const [code, setCode] = useState(initialCode);
  const [name, setName] = useState(store.myName.value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      class="join"
      onSubmit={(e) => {
        e.preventDefault();
        void run(() => store.join(code, name.trim() || '匿名'));
      }}
    >
      <div class="brand">
        <div class="disc" aria-hidden="true" />
        <h1>MusicTogether</h1>
        <p class="tagline">
          {initialCode
            ? '有人邀请你一起听歌。填个昵称就能进房间。'
            : '和另一个人听同一首歌，进度条保持同步。'}
        </p>
      </div>

      <label>
        你的昵称
        <input
          value={name}
          onInput={(e) => setName((e.target as HTMLInputElement).value)}
          placeholder="阿甲"
          maxLength={24}
        />
      </label>

      <label>
        房间码
        <input
          class="code-input"
          value={code}
          // 边输入边归一化：粘贴 "k-7-m-2-q-x" 会直接显示成 K7M2QX。
          // 这里**不能**加 maxLength —— 它按原始字符数截断，
          // 粘贴带分隔符的房间码会被砍成半截（"k-7-m-2-q" → K7M2）。
          // 长度由归一化后的 slice(0, 6) 保证。
          onInput={(e) =>
            setCode(normalizeCode((e.target as HTMLInputElement).value).slice(0, 6))
          }
          placeholder="K7M2QX"
          autocapitalize="characters"
          autocomplete="off"
          spellcheck={false}
        />
      </label>

      {error && <p class="error">{error}</p>}

      <div class="row">
        <button type="submit" disabled={busy || code.length < 6}>
          加入
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void run(() => store.createRoom(name.trim() || '匿名'))}
        >
          创建一个新房间
        </button>
      </div>

      <p class="footnote small">身份存在这台设备的浏览器里（{getOrCreateClientId().slice(0, 8)}…）。</p>
    </form>
  );
}
