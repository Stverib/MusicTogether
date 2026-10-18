import { useState } from 'preact/hooks';
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
      <h1>MusicTogether</h1>
      <p class="muted">和另一个人听同一首歌，进度条保持同步。</p>

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
          value={code}
          onInput={(e) => setCode((e.target as HTMLInputElement).value.toUpperCase())}
          placeholder="K7M2QX"
          maxLength={8}
          autocapitalize="characters"
          autocomplete="off"
          spellcheck={false}
        />
      </label>

      {error && <p class="error">{error}</p>}

      <div class="row">
        <button type="submit" disabled={busy || code.trim().length < 6}>
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

      <p class="muted small">身份存在这台设备的浏览器里（{getOrCreateClientId().slice(0, 8)}…）。</p>
    </form>
  );
}
