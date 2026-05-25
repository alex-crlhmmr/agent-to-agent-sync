// peerd — agent-to-agent sync daemon

import { loadConfig } from "./config.js";
import { ensureTls } from "./tls.js";
import { PeerServer } from "./server.js";
import { CallManager } from "./call_manager.js";
import { ControlServer } from "./control.js";
import { dialPeer } from "./client.js";
import type { Connection } from "./connection.js";

async function main() {
  const config = await loadConfig();
  const tls = await ensureTls(config.stateDir, config.self);

  console.log(`[peerd] starting as "${config.self}", listening on :${config.port}`);
  console.log(`[peerd] state dir:           ${config.stateDir}`);
  console.log(`[peerd] tls fingerprint:     ${tls.fingerprintSha256}`);
  console.log(`[peerd] control socket:      ${config.controlSocketPath}`);
  console.log(`[peerd] known peers:         ${Object.keys(config.peers).join(", ") || "(none)"}`);

  const connections = new Map<string, Connection>();
  const peerServer = new PeerServer({ config, tls });
  const callManager = new CallManager({
    selfName: config.self,
    stateDir: config.stateDir,
    getConnection: (name) => connections.get(name) ?? undefined,
  });
  const controlServer = new ControlServer({
    socketPath: config.controlSocketPath,
    cm: callManager,
    config,
    getConnection: (name) => connections.get(name) ?? undefined,
  });

  // Wire inbound connections.
  peerServer.on("connection", (conn: Connection) => {
    conn.once("ready", (info: { peerName: string; agreedCapabilities: string[] }) => {
      console.log(`[peerd] inbound: handshake done with ${info.peerName}; caps=[${info.agreedCapabilities.join(",")}]`);
      connections.set(info.peerName, conn);
      callManager.attachConnection(conn);
    });
    conn.once("close", (reason: string) => {
      for (const [k, v] of connections) if (v === conn) connections.delete(k);
      console.log(`[peerd] inbound closed: ${reason}`);
    });
    conn.on("error", (err: Error) => console.log(`[peerd] inbound error: ${err.message}`));
  });

  await peerServer.start();
  await controlServer.start();
  console.log(`[peerd] WSS listening on :${config.port}`);
  console.log(`[peerd] control socket ready`);

  // Eagerly dial known peers in background; reconnect on close.
  for (const [name, _entry] of Object.entries(config.peers)) {
    void maintainOutbound(config.self, name, config, connections, callManager);
  }

  const shutdown = async () => {
    console.log("[peerd] shutting down");
    for (const c of connections.values()) c.close(1000, "shutdown");
    await controlServer.stop();
    await peerServer.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function maintainOutbound(
  self: string,
  peerName: string,
  config: Awaited<ReturnType<typeof loadConfig>>,
  connections: Map<string, Connection>,
  cm: CallManager,
): Promise<void> {
  while (true) {
    if (connections.has(peerName)) {
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    try {
      const conn = await dialPeer({ selfName: self, peerName, peer: config.peers[peerName] });
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("handshake timeout")), 5000);
        conn.once("ready", () => { clearTimeout(t); resolve(); });
        conn.once("error", (e) => { clearTimeout(t); reject(e); });
      });
      console.log(`[peerd] outbound: handshake done with ${peerName}`);
      connections.set(peerName, conn);
      cm.attachConnection(conn);
      await new Promise<void>((resolve) => conn.once("close", () => {
        connections.delete(peerName);
        resolve();
      }));
      console.log(`[peerd] outbound to ${peerName} closed; will retry`);
    } catch (e: any) {
      // backoff and retry
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

main().catch((err) => {
  console.error("[peerd] fatal:", err);
  process.exit(1);
});
