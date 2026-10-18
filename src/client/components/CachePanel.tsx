import { useEffect, useState } from 'preact/hooks';
import { clearCache, deleteCached, estimateUsage, listCached, type CachedEntry } from '../cache';
import { store } from '../store';

function mb(n: number): string {
  return `${(n / 1048576).toFixed(1)} MB`;
}

export function CachePanel() {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<CachedEntry[]>([]);
  const [usage, setUsage] = useState({ usage: 0, quota: 0 });

  const room = store.room.value;

  const refresh = async () => {
    setEntries(await listCached());
    setUsage(await estimateUsage());
  };

  useEffect(() => {
    if (open) void refresh();
  }, [open]);

  const total = entries.reduce((sum, e) => sum + e.size, 0);

  return (
    <section class="panel">
      <h2>
        <button class="link" onClick={() => setOpen(!open)}>
          本地缓存（{entries.length} 首{open ? `，共 ${mb(total)}` : ''}）
        </button>
      </h2>

      {open && (
        <>
          <p class="muted small">
            浏览器给这个站点的配额：已用 {mb(usage.usage)} / {mb(usage.quota)}
          </p>

          {entries.length === 0 && <p class="muted small">还没有缓存任何歌。</p>}

          <ul class="list">
            {entries.map((e) => {
              const track = room?.tracks.find((t) => t.id === e.trackId);
              return (
                <li key={e.trackId}>
                  <span class="name grow">{track?.name ?? '（已不在房间里的歌）'}</span>
                  <span class="muted small">{mb(e.size)}</span>
                  <button
                    class="icon"
                    title="删除这首的缓存"
                    onClick={() =>
                      void deleteCached(e.trackId).then(refresh)
                    }
                  >
                    ✕
                  </button>
                </li>
              );
            })}
          </ul>

          {entries.length > 0 && (
            <button onClick={() => void clearCache().then(refresh)}>全部清空</button>
          )}
        </>
      )}
    </section>
  );
}
