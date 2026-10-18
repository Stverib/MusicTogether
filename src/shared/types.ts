export type Track = {
  id: string;
  name: string;
  size: number;
  mime: string;
  uploaderId: string;
  uploaderName: string;
  addedAt: number;
};

export type Member = {
  clientId: string;
  name: string;
  joinedAt: number;
};

/**
 * 播放锚点。服务端只存"从哪一刻、从哪个位置开始播"，不存"当前进度"。
 * 当前位置由 positionAt() 现算，这样服务端在没人操作时完全不需要说话。
 */
export type Playback = {
  trackId: string | null;
  positionMs: number;
  /** positionMs 对应的服务端时刻（Unix 毫秒） */
  anchorAt: number;
  isPlaying: boolean;
  /** 单调递增，客户端据此丢弃乱序到达的帧 */
  seq: number;
};

export type RoomState = {
  code: string;
  name: string;
  createdAt: number;
  members: Member[];
  tracks: Track[];
  /** trackId 的有序数组。曲目表与队列分开，因此"移出队列"不会删歌 */
  queue: string[];
  playback: Playback;
  /** 曲目表 / 队列的结构版本号 */
  epoch: number;
};
