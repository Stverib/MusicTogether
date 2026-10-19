#!/usr/bin/env node
// 局域网直连用的服务启动器。
//
// 存在的理由有两个，都不只是"图方便"：
//
// 1. `npm run dev:worker` 只绑 localhost，别的设备根本连不上。放开要加
//    `--ip 0.0.0.0`，可那样又得知道本机在局域网里是哪一串地址 —— 那是
//    DHCP 给的、会变；而且 Windows 的 `networkInterfaces()` 里还混着
//    VMware / Hyper-V / WSL 的虚拟网卡，随手挑一个就是别人连不上的那种。
//
// 2. **操作者也必须从局域网地址进入，不能从 localhost 进入。**
//    「分享房间」的链接是按 `location.origin` 生成的 —— 从 localhost 进入，
//    生成的就是 `http://localhost:8787/r/CODE`，发给其他参与者是一串打不开的东西，
//    而且这个错误毫无提示，只有对方点开发现打不开才知道。

import { spawn } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';

const PORT = process.env.PORT ?? '8787';

/** 虚拟网卡的名字特征。它们的地址别人连不上，排在前面只会误导。 */
const VIRTUAL =
  /vmware|virtualbox|hyper-?v|wsl|docker|vethernet|tailscale|zerotier|radmin|loopback|bluetooth|npcap|tap-|tun\d/i;

function candidates() {
  const out = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      // 169.254.x.x 是自动私有地址，等于这块网卡压根没配上
      if (a.address.startsWith('169.254.')) continue;
      out.push({ name, address: a.address, virtual: VIRTUAL.test(name) });
    }
  }
  // 真网卡优先；同为真网卡时，家用/办公网络更常见的段优先
  const rank = (c) =>
    (c.virtual ? 100 : 0) +
    (c.address.startsWith('192.168.') ? 0 : c.address.startsWith('10.') ? 1 : 2);
  return out.sort((a, b) => rank(a) - rank(b));
}

const found = candidates();
const best = found[0];

if (!best) {
  console.error(
    '\n  没找到任何可用的局域网地址 —— 这台机器现在没有连上任何网络。\n' +
      '  先连上局域网 / WiFi 再跑这个命令。\n',
  );
  process.exit(1);
}

const url = `http://${best.address}:${PORT}`;
const others = found.slice(1);

console.log(`
  MusicTogether —— 局域网直连
  ────────────────────────────────────────────────────────
  本机打开：    ${url}
  分享地址：    ${url}      （需要与你在同一局域网）
  选中的网卡：  ${best.name}
${others.length ? `  其它候选：    ${others.map((c) => `${c.address} (${c.name})`).join('\n                ')}\n` : ''}
  ⚠ 用上面这个地址，不要用 http://localhost:${PORT} ——
    「分享房间」的链接是按当前地址生成的，localhost 的链接在其他设备上打不开。

  ⚠ 这是明文 HTTP，同网段的人扫到端口就能打开这个页面。
    用完 Ctrl-C 停掉，别让它一直开着。
`);

// 只想看地址、不想真起服务：`node scripts/dev-lan.mjs --print-only`
if (process.argv.includes('--print-only')) process.exit(0);

// 直接起 wrangler 的入口，不走 `npx`。
// 走 npx 在 Windows 上会多出一层 `cmd.exe`（`shell: true` 的代价），
// 那层 shell 不在 node 的进程树里，Ctrl-C 之外的收尾方式都杀不干净，
// 结果就是 8787 上留着一个还监听着 0.0.0.0 的孤儿进程。
const wranglerBin = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));

const child = spawn(process.execPath, [wranglerBin, 'dev', '--ip', '0.0.0.0', '--port', PORT], {
  stdio: 'inherit',
});

child.on('exit', (code) => process.exit(code ?? 0));
