// `peerd list` — show known peers + their online state.

import { ControlClient, readPeersToml } from "../lib/peerd.js";

export async function cmdList(_args: string[]): Promise<number> {
  const t = readPeersToml();
  const names = Object.keys(t.peers);
  if (names.length === 0) {
    console.log("peerd: no peers configured. Use `peerd pair <hostname>` to add one.");
    return 0;
  }

  // Try to enrich with online state from a running peerd; fall back to peers.toml only.
  let online: Record<string, boolean> = {};
  try {
    const client = await ControlClient.connect();
    const res = await client.call<{ peers: { name: string; online: boolean }[] }>("list_peers", {}, { timeoutMs: 2000 });
    for (const p of res.peers ?? []) online[p.name] = p.online;
    client.close();
  } catch { /* daemon not running, that's fine */ }

  const w = Math.max(...names.map((n) => n.length), 4);
  console.log(`self: ${t.self}  port: ${t.port}`);
  console.log("");
  console.log(`${"name".padEnd(w)}  host                                           online`);
  console.log(`${"".padEnd(w, "-")}  ---------------------------------------------  ------`);
  for (const name of names) {
    const e = t.peers[name];
    const onlineStr = name in online ? (online[name] ? "✔" : "—") : "?";
    console.log(`${name.padEnd(w)}  ${e.host.padEnd(45)}  ${onlineStr}`);
  }
  return 0;
}
