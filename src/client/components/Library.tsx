import { useRef, useState } from 'preact/hooks';
import { probeAudio } from '../audioProbe';
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

  const takeFiles = async (files: File[]) => {
    const audio = filterAudio(files);
    if (!audio.length) {
      setError('这个位置没有找到音频文件');
      return;
    }

    // 扩展名可能是骗人的：把只有视频轨的 MP4 改名成 .mp3 也能选进来，
    // 但播放器永远不会有声音。先探一下，别让它进房间。
    const playable: File[] = [];
    const silent: string[] = [];
    for (const file of audio) {
      if ((await probeAudio(file)) === 'no-audio') silent.push(file.name);
      else playable.push(file);
    }

    setError(
      silent.length
        ? `${silent.join('、')} 里没有音频轨道，可能是把视频文件改成了 .mp3；已跳过。`
        : null,
    );
    setPicked(playable.length ? playable : null);
  };

  const chooseFolder = async () => {
    // 桌面 Chrome/Edge 有目录选择 API；手机没有，退化到 webkitdirectory
    const fromApi = await pickDirectory();
    if (fromApi) {
      await takeFiles(fromApi);
      return;
    }
    dirInput.current?.click();
  };

  const doUpload = async () => {
    const batch = picked;
    if (!batch) return;
    for (let i = 0; i < batch.length; i++) {
      const file = batch[i]!;
      setProgress({ done: i, total: batch.length, name: file.name });
      try {
        // 上传完不用自己入队：服务端在字节落地后会把它加进队列
        await uploadTrack(room.code, file);
      } catch (e) {
        setError(`${file.name}：${(e as Error).message}`);
      }
    }
    setProgress(null);
    // 上传期间用户可能又选了一批。这时只清掉自己这一批 ——
    // 直接 setPicked(null) 会把用户刚选的文件悄悄吞掉。
    setPicked((cur) => (cur === batch ? null : cur));
  };

  return (
    <section class="panel library">
      <h2>添加歌曲</h2>

      <div class="row">
        <button onClick={() => void chooseFolder()}>选文件夹</button>
        <button onClick={() => fileInput.current?.click()}>选文件</button>
      </div>

      <input
        type="file"
        multiple
        hidden
        // webkitdirectory 是非标准属性，Preact 的 JSX 类型里没有它。
        // 手机端"选一个文件夹"只能靠它，所以在 ref 里直接设 —— 运行时完全等价。
        ref={(el) => {
          dirInput.current = el;
          el?.setAttribute('webkitdirectory', '');
        }}
        onChange={(e) => void takeFiles([...(e.target as HTMLInputElement).files ?? []])}
      />
      <input
        type="file"
        ref={fileInput}
        accept="audio/*"
        multiple
        hidden
        onChange={(e) => void takeFiles([...(e.target as HTMLInputElement).files ?? []])}
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
