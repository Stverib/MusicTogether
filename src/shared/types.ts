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
  /**
   * 人断开连接后**不从列表里删掉**，只把这里翻成 false。
   *
   * 删掉的话"已离开"这个状态根本不存在，而这个列表的意义正是"谁在这个房间里"
   * —— 一起听歌时看得见其他成员刚走，比看得见他凭空消失更像一个房间。
   */
  online: boolean;
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

/**
 * 一条聊天消息。
 *
 * 与第一版不同，聊天**现在会落库**（决策 D12）。`id` 是房间内单调递增的序号，
 * 用来给"取更早的消息"当游标 —— 用时间戳当游标不行，同一毫秒内可能有多条。
 */
export type ChatMessage = {
  id: number;
  from: string;
  name: string;
  text: string;
  at: number;
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
