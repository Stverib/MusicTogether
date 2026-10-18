import { store } from '../store';

export function Members() {
  const members = store.room.value?.members ?? [];
  const myName = store.myName.value;

  return (
    <section class="panel members">
      <h2>成员（{members.length}）</h2>
      <ul class="list">
        {members.map((m) => (
          <li key={m.clientId}>
            <span class="name">{m.name}</span>
            {m.name === myName && <span class="muted small">（你）</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}
