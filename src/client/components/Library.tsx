import { useRef, useState } from 'preact/hooks';
import { filterAudio, pickDirectory, uploadTrack } from '../sources';
import { store } from '../store';

export function Library() {
  const [picked, setPicked] = useState<File[] | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number; name: string } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const dirInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const room = store.room.value!;

  const takeFiles = (files: File[]) => {
    const audio = filterAudio(files);
    if (!audio.length) {
      setError('这个位置没有找到音频文件');
      return;
    }
    setError(null);
    setPicked(audio);
  };

  const chooseFolder = async () => {
    // 桌面 Chrome/Edge 有目录选择 API；手机没有，退化到 webkitdirectory
    const fromApi = await pickDirectory();
    if (fromApi) {
      takeFiles(fromApi);
      return;
    }
    dirInput.current?.click();
  };

  const doUpload = async () => {
    if (!picked) return;
    for (let i = 0; i < picked.length; i++) {
      const file = picked[i]!;
      setProgress({ done: i, total: picked.length, name: file.name });
      try {
        const trackId = await uploadTrack(room.code, file);
        store.send({ type: 'enqueue', trackId });
      } catch (e) {
        setError(`${file.name}：${(e as Error).message}`);
      }
    }
    setProgress(null);
    setPicked(null);
  };

  return (
    <section class="panel">
      <h2>添加歌曲</h2>

      <div class="row">
        <button onClick={() => void chooseFolder()}>选文件夹</button>
        <button onClick={() => fileInput.current?.click()}>选文件</button>
      </div>

      <input
        type="file"
        ref={dirInput}
        webkitdirectory
        multiple
        hidden
        onChange={(e) => takeFiles([...(e.target as HTMLInputElement).files ?? []])}
      />
      <input
        type="file"
        ref={fileInput}
        accept="audio/*"
        multiple
        hidden
        onChange={(e) => takeFiles([...(e.target as HTMLInputElement).files ?? []])}
      />

      {error && <p class="error">{error}</p>}

      {picked && !progress && (
        <>
          <p class="muted small">找到 {picked.length} 首。</p>
          <ul class="list picklist">
            {picked.slice(0, 50).map((f) => (
              <li key={f.name}>
                <span class="name">{f.name}</span>
              </li>
            ))}
            {picked.length > 50 && <li class="muted">…还有 {picked.length - 50} 首</li>}
          </ul>
          <div class="row">
            <button class="primary" onClick={() => void doUpload()}>
              全部上传
            </button>
            <button onClick={() => setPicked(null)}>取消</button>
          </div>
        </>
      )}

      {progress && (
        <p class="muted small">
          正在上传 {progress.done + 1}/{progress.total}：{progress.name}
        </p>
      )}
    </section>
  );
}
