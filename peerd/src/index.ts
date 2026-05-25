// peerd — agent-to-agent sync daemon

import * as fs from "node:fs";
import * as path from "node:path";
import { stringify as stringifyToml } from "@iarna/toml";
import { loadConfig } from "./config.js";
import { ensureTls } from "./tls.js";
import { PeerServer, type PairCompleted } from "./server.js";
import { CallManager } from "./call_manager.js";
import { ControlServer } from "./control.js";
import { dialPeer } from "./client.js";
import type { Connection } from "./connection.js";
import type { PeerEntry } from "./config.js";

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
  // Persist a freshly paired peer into peers.toml and hot-add to in-memory config.
  // Both pairing paths (inbound HTTP /pair and CLI-driven outbound `pair` command)
  // end up calling addPeer to commit the new entry.
  const addPeer = async (entry: {
    name: string;
    host: string;
    port: number;
    outgoing_token: string;
    inbound_token: string;
    fingerprint: string;
  }): Promise<boolean> => {
    try {
      const peer: PeerEntry = {
        host: entry.host,
        port: entry.port,
        token: entry.outgoing_token,     // token WE present to them
        inboundToken: entry.inbound_token, // token we EXPECT from them
        fingerprint: entry.fingerprint,
      };
      config.peers[entry.name] = peer;
      await persistPeersToml(config);
      console.log(`[peerd] paired with "${entry.name}" at ${entry.host}:${entry.port}`);
      // Start the outbound dial loop for the new peer.
      void maintainOutbound(config.self, entry.name, config, connections, callManager);
      return true;
    } catch (e: any) {
      console.error(`[peerd] failed to persist new peer "${entry.name}":`, e?.message ?? e);
      return false;
    }
  };

  const controlServer = new ControlServer({
    socketPath: config.controlSocketPath,
    cm: callManager,
    config,
    getConnection: (name) => connections.get(name) ?? undefined,
    enterPairingMode: (s) => peerServer.enterPairingMode(s),
    exitPairingMode: () => peerServer.exitPairingMode(),
    isPairingMode: () => peerServer.isPairing(),
    addPeer,
    getSelfInfo: () => ({ name: config.self, port: config.port, fingerprint: tls.fingerprintSha256 }),
  });

  // When a /pair request succeeds, commit the new peer.
  peerServer.on("pair_completed", (evt: PairCompleted, ack: (ok: boolean) => void) => {
    addPeer({
      name: evt.peer_name,
      host: evt.peer_host,
      port: evt.peer_port,
      outgoing_token: evt.our_outgoing_token, // we will present this TO them
      inbound_token: evt.peer_outgoing_token, // we will expect this FROM them
      fingerprint: evt.peer_fingerprint,
    }).then(ack);
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

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) {
      // Second signal — give up on graceful, just exit.
      console.log("[peerd] forced exit");
      process.exit(1);
    }
    shuttingDown = true;
    console.log("[peerd] shutting down");
    // Hard deadline: if graceful shutdown takes >2s, force exit.
    // systemd/launchctl restart should be near-instant; never block on
    // half-closed sockets.
    const killer = setTimeout(() => {
      console.log("[peerd] shutdown deadline exceeded, force-exiting");
      process.exit(1);
    }, 2000);
    try {
      for (const c of connections.values()) {
        try { c.close(1000, "shutdown"); } catch { /* ignore */ }
      }
      await Promise.all([
        controlServer.stop().catch(() => {}),
        peerServer.stop().catch(() => {}),
      ]);
    } finally {
      clearTimeout(killer);
      process.exit(0);
    }
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

async function persistPeersToml(config: Awaited<ReturnType<typeof loadConfig>>): Promise<void> {
  const peersObj: Record<string, Record<string, unknown>> = {};
  for (const [name, p] of Object.entries(config.peers)) {
    const entry: Record<string, unknown> = {
      host: p.host,
      port: p.port,
      token: p.token,
    };
    if (p.inboundToken) entry.inbound_token = p.inboundToken;
    if (p.fingerprint) entry.fingerprint = p.fingerprint;
    peersObj[name] = entry;
  }
  const out: any = {
    self: config.self,
    port: config.port,
    peers: peersObj,
  };
  const file = path.join(config.stateDir, "peers.toml");
  await fs.promises.writeFile(file, stringifyToml(out));
}

main().catch((err) => {
  console.error("[peerd] fatal:", err);
  process.exit(1);
});
