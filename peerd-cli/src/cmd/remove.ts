// `peerd remove <peer-name>` — drop a peer from peers.toml.

import { readPeersToml, writePeersToml } from "../lib/peerd.js";

export async function cmdRemove(args: string[]): Promise<number> {
  const name = args[0];
  if (!name) {
    console.error("usage: peerd remove <peer-name>");
    return 2;
  }
  const t = readPeersToml();
  if (!(name in t.peers)) {
    console.error(`peerd: no peer named "${name}". Known peers: ${Object.keys(t.peers).join(", ") || "(none)"}`);
    return 1;
  }
  delete t.peers[name];
  writePeersToml(t);
  console.log(`peerd: removed peer "${name}" from peers.toml.`);
  console.log(`Restart peerd to drop the in-memory connection.`);
  return 0;
}
