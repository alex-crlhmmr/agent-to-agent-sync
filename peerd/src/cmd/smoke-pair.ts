// Smoke test: validate the pairing flow end-to-end.
//
// Boots two peerds with EMPTY peers.toml. Has alice enter pairing mode, then
// invokes the same logic peerd-cli's `pair` command would: POST credentials
// to alice's /pair, get her credentials back, write both sides' peers.toml.
// Finally validates that a subsequent peer_invite works.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as https from "node:https";
import * as crypto from "node:crypto";
import { loadConfig } from "../config.js";
import { ensureTls } from "../tls.js";
import { PeerServer, type PairCompleted } from "../server.js";
import { CallManager } from "../call_manager.js";
import { ControlServer } from "../control.js";
import { dialPeer } from "../client.js";
import { ControlClient } from "../control_client.js";
import type { Connection } from "../connection.js";
import type { PeerEntry } from "../config.js";
import { stringify as stringifyToml } from "@iarna/toml";

async function freshStateDir(label: string): Promise<string> {
  const dir = path.join(os.tmpdir(), `peerd-smoke-pair-${label}-${Date.now()}`);
  await fs.promises.rm(dir, { recursive: true, force: true });
  await fs.promises.mkdir(dir, { recursive: true });
  // Write a peers.toml stub with self name + port, no peers yet.
  const tomlPath = path.join(dir, "peers.toml");
  await fs.promises.writeFile(tomlPath, `self = "${label}"\nport = ${label === "alice" ? 17827 : 17828}\n`);
  return dir;
}

interface PeerdNode {
  name: string;
  config: Awaited<ReturnType<typeof loadConfig>>;
  peerServer: PeerServer;
  controlServer: ControlServer;
  cm: CallManager;
  connections: Map<string, Connection>;
}

async function bootNode(name: string, dir: string): Promise<PeerdNode> {
  const config = await loadConfig({ stateDir: dir });
  const tls = await ensureTls(dir, name);
  const connections = new Map<string, Connection>();
  const cm = new CallManager({
    selfName: config.self,
    stateDir: config.stateDir,
    getConnection: (peer) => connections.get(peer),
  });
  const peerServer = new PeerServer({ config, tls });
  peerServer.on("connection", (conn: Connection) => {
    conn.once("ready", (info: { peerName: string }) => {
      connections.set(info.peerName, conn);
      cm.attachConnection(conn);
    });
    conn.once("close", () => {
      for (const [k, v] of connections) if (v === conn) connections.delete(k);
    });
  });

  const addPeer = async (entry: {
    name: string;
    host: string;
    port: number;
    outgoing_token: string;
    inbound_token: string;
    fingerprint: string;
  }): Promise<boolean> => {
    const peer: PeerEntry = {
      host: entry.host,
      port: entry.port,
      token: entry.outgoing_token,
      inboundToken: entry.inbound_token,
      fingerprint: entry.fingerprint,
    };
    config.peers[entry.name] = peer;
    // Persist peers.toml.
    const peersObj: Record<string, Record<string, unknown>> = {};
    for (const [n, p] of Object.entries(config.peers)) {
      peersObj[n] = { host: p.host, port: p.port, token: p.token };
      if (p.inboundToken) (peersObj[n] as any).inbound_token = p.inboundToken;
      if (p.fingerprint) (peersObj[n] as any).fingerprint = p.fingerprint;
    }
    const out: any = { self: config.self, port: config.port, peers: peersObj };
    await fs.promises.writeFile(path.join(dir, "peers.toml"), stringifyToml(out));
    return true;
  };

  await peerServer.start();

  const controlServer = new ControlServer({
    socketPath: config.controlSocketPath,
    cm,
    config,
    getConnection: (peer) => connections.get(peer),
    enterPairingMode: (s) => peerServer.enterPairingMode(s),
    exitPairingMode: () => peerServer.exitPairingMode(),
    isPairingMode: () => peerServer.isPairing(),
    addPeer,
    getSelfInfo: () => ({ name: config.self, port: config.port, fingerprint: tls.fingerprintSha256 }),
  });

  peerServer.on("pair_completed", (evt: PairCompleted, ack: (ok: boolean) => void) => {
    addPeer({
      name: evt.peer_name,
      host: evt.peer_host,
      port: evt.peer_port,
      outgoing_token: evt.our_outgoing_token,
      inbound_token: evt.peer_outgoing_token,
      fingerprint: evt.peer_fingerprint,
    }).then(ack);
  });

  await controlServer.start();
  return { name, config, peerServer, controlServer, cm, connections };
}

function postJson<T>(url: string, body: unknown, timeoutMs: number): Promise<T> {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  return new Promise<T>((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      method: "POST",
      host: u.hostname,
      port: u.port ? Number(u.port) : 443,
      path: u.pathname,
      headers: { "Content-Type": "application/json", "Content-Length": payload.length },
      rejectUnauthorized: false,
      timeout: timeoutMs,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode !== 200) return reject(new Error(`${res.statusCode}: ${raw}`));
        try { resolve(JSON.parse(raw) as T); } catch (e: any) { reject(e); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function main() {
  const aliceDir = await freshStateDir("alice");
  const bobDir = await freshStateDir("bob");

  const alice = await bootNode("alice", aliceDir);
  const bob = await bootNode("bob", bobDir);
  console.log("[smoke-pair] both peerds up");

  // Sanity: both have empty peers config.
  if (Object.keys(alice.config.peers).length !== 0 || Object.keys(bob.config.peers).length !== 0) {
    throw new Error("expected empty peers on both sides at boot");
  }

  // 1. Alice enters pairing mode via her control socket.
  const aliceClient = await ControlClient.connect(alice.config.controlSocketPath);
  const enter = await aliceClient.call<{ ok: boolean; expires_at: string }>("enter_pairing_mode", { seconds: 60 });
  console.log(`[smoke-pair] alice in pairing mode until ${enter.expires_at}`);
  aliceClient.close();

  // 2. Bob runs `pair` flow against alice.
  const bobClient = await ControlClient.connect(bob.config.controlSocketPath);
  const bobSelf = await bobClient.call<{ name: string; port: number; fingerprint: string }>("get_self", {});
  const bobOutgoingToken = "sk_peer_" + crypto.randomBytes(24).toString("hex");

  const pairResp = await postJson<{ name: string; port: number; token: string; fingerprint: string }>(
    `https://127.0.0.1:${alice.config.port}/pair`,
    {
      name: bobSelf.name,
      host: "127.0.0.1",
      port: bobSelf.port,
      token: bobOutgoingToken,
      fingerprint: bobSelf.fingerprint,
    },
    10_000,
  );
  console.log(`[smoke-pair] bob got pair response: name=${pairResp.name} fp=${pairResp.fingerprint.slice(0, 24)}…`);

  // 3. Bob writes his peers.toml entry via control socket.
  const addRes = await bobClient.call<{ ok: boolean }>("add_peer", {
    name: pairResp.name,
    host: "127.0.0.1",
    port: pairResp.port,
    outgoing_token: bobOutgoingToken,
    inbound_token: pairResp.token,
    fingerprint: pairResp.fingerprint,
  });
  bobClient.close();
  if (!addRes.ok) throw new Error("bob add_peer returned ok=false");

  // 4. Verify both peers.toml have entries on disk.
  const alicePeersToml = await fs.promises.readFile(path.join(aliceDir, "peers.toml"), "utf8");
  const bobPeersToml = await fs.promises.readFile(path.join(bobDir, "peers.toml"), "utf8");
  if (!alicePeersToml.includes("[peers.bob]")) throw new Error("alice's peers.toml missing [peers.bob]");
  if (!bobPeersToml.includes("[peers.alice]")) throw new Error("bob's peers.toml missing [peers.alice]");
  console.log("[smoke-pair] both peers.toml written:");
  console.log("  alice ->", alicePeersToml.split("\n").filter((l) => l.includes("=") || l.startsWith("[")).join(" "));
  console.log("  bob   ->", bobPeersToml.split("\n").filter((l) => l.includes("=") || l.startsWith("[")).join(" "));

  // 5. Bob dials alice with the new credentials — proves the pair worked.
  const conn = await dialPeer({
    selfName: bob.config.self,
    peerName: "alice",
    peer: bob.config.peers["alice"],
  });
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("dial handshake timeout")), 5000);
    conn.once("ready", () => { clearTimeout(t); resolve(); });
    conn.once("error", (e) => { clearTimeout(t); reject(e); });
  });
  console.log("[smoke-pair] post-pair handshake succeeded");

  // Teardown.
  conn.close();
  for (const c of alice.connections.values()) c.close();
  for (const c of bob.connections.values()) c.close();
  await alice.controlServer.stop();
  await bob.controlServer.stop();
  await alice.peerServer.stop();
  await bob.peerServer.stop();

  console.log("[smoke-pair] PASS");
  process.exit(0);
}

main().catch((err) => {
  console.error("[smoke-pair] FAIL:", err);
  process.exit(1);
});
