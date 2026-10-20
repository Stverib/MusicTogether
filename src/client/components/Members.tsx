import { store } from '../store';

export function Members() {
  const members = store.room.value?.members ?? [];
  const myName = store.myName.value;

  // 在线的排前面，各自按加入时间。已离开的人留在列表里是有意的 ——
  // 一起听歌时看得见其他成员刚走，比看得见他凭空消失更像一个房间。
  //
  // "在线"是连接还在**且**页面在前台。最小化窗口、切到别的应用都不会断开
  // WebSocket，只看 online 的话，人明明走了点还是绿的。
  const isPresent = (m: (typeof members)[number]) => m.online && !m.away;
  const sorted = [...members].sort(
    (a, b) => Number(isPresent(b)) - Number(isPresent(a)) || a.joinedAt - b.joinedAt,
  );
  const online = members.filter(isPresent).length;
  const away = members.length - online;

  return (
    <section class="panel members">
      <h2>
        成员（{online} 在线{away > 0 ? ` · ${away} 已离开` : ''}）
      </h2>
      <ul class="list">
        {sorted.map((m) => (
          <li key={m.clientId} class={isPresent(m) ? '' : 'away'}>
            <span class="name">{m.name}</span>
            {/* 绿点在线、灰点已离开，跟在名字右边 */}
            <span class={`presence ${isPresent(m) ? 'on' : 'off'}`} aria-hidden="true" />
            {m.name === myName && <span class="muted small">（你）</span>}
            <span class="grow" />
            {/* 状态用文字说一遍，不能只靠颜色 —— 色觉障碍的人也要能读出来 */}
            <span class="muted small">{isPresent(m) ? '在线' : '已离开'}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
