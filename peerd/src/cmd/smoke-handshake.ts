// Smoke test: spin up two peerds in-process, dial one from the other,
// verify HELLO/WELCOME completes. Exits 0 on success, 1 on failure.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig } from "../config.js";
import { ensureTls } from "../tls.js";
import { PeerServer } from "../server.js";
import { dialPeer } from "../client.js";
import type { Connection } from "../connection.js";

const TOKEN_AB = "tok_alex_to_bob";
const TOKEN_BA = "tok_bob_to_alex";

async function writePeerToml(stateDir: string, self: string, port: number, peerName: string, peerPort: number, ourOut: string, ourIn: string, peerFingerprint?: string) {
  const lines = [
    `self = "${self}"`,
    `port = ${port}`,
    "",
    `[peers.${peerName}]`,
    `host = "127.0.0.1"`,
    `port = ${peerPort}`,
    `token = "${ourOut}"`,
    `inbound_token = "${ourIn}"`,
  ];
  if (peerFingerprint) lines.push(`fingerprint = "${peerFingerprint}"`);
  await fs.promises.mkdir(stateDir, { recursive: true });
  await fs.promises.writeFile(path.join(stateDir, "peers.toml"), lines.join("\n") + "\n");
}

async function freshStateDir(label: string): Promise<string> {
  const dir = path.join(os.tmpdir(), `peerd-smoke-${label}-${Date.now()}`);
  await fs.promises.rm(dir, { recursive: true, force: true });
  await fs.promises.mkdir(dir, { recursive: true });
  return dir;
}

async function main() {
  const aliceDir = await freshStateDir("alice");
  const bobDir = await freshStateDir("bob");

  // First write peers.toml without fingerprints so initial TLS gets generated.
  await writePeerToml(aliceDir, "alice", 17777, "bob",   17778, TOKEN_AB, TOKEN_BA);
  await writePeerToml(bobDir,   "bob",   17778, "alice", 17777, TOKEN_BA, TOKEN_AB);

  // Generate TLS for each so we can pin fingerprints.
  const aliceTls = await ensureTls(aliceDir, "alice");
  const bobTls   = await ensureTls(bobDir,   "bob");

  // Rewrite peers.toml with pinned fingerprints.
  await writePeerToml(aliceDir, "alice", 17777, "bob",   17778, TOKEN_AB, TOKEN_BA, bobTls.fingerprintSha256);
  await writePeerToml(bobDir,   "bob",   17778, "alice", 17777, TOKEN_BA, TOKEN_AB, aliceTls.fingerprintSha256);

  const aliceConfig = await loadConfig({ stateDir: aliceDir });
  const bobConfig   = await loadConfig({ stateDir: bobDir });

  const aliceServer = new PeerServer({ config: aliceConfig, tls: aliceTls });
  const bobServer   = new PeerServer({ config: bobConfig,   tls: bobTls });

  let aliceInboundReady = false;
  aliceServer.on("connection", (conn: Connection) => {
    conn.on("ready", () => { aliceInboundReady = true; });
  });
  bobServer.on("connection", (conn: Connection) => {
    conn.on("ready", () => {/* unused on bob side here */});
  });

  await aliceServer.start();
  await bobServer.start();

  console.log(`[smoke] both servers up. alice fp=${aliceTls.fingerprintSha256}`);
  console.log(`[smoke] both servers up. bob   fp=${bobTls.fingerprintSha256}`);

  // Bob dials Alice.
  const conn = await dialPeer({
    selfName: bobConfig.self,
    peerName: "alice",
    peer: bobConfig.peers["alice"],
  });

  const ready = await new Promise<{ peerName: string; agreedCapabilities: string[] }>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("client handshake timeout")), 5000);
    conn.once("ready", (info) => { clearTimeout(t); resolve(info); });
    conn.once("error", (e) => { clearTimeout(t); reject(e); });
  });

  console.log(`[smoke] client handshake ready: peer=${ready.peerName} caps=[${ready.agreedCapabilities.join(",")}]`);

  // Give Alice's inbound a moment to also flip ready.
  await new Promise((r) => setTimeout(r, 200));

  conn.close(1000, "done");
  await new Promise((r) => setTimeout(r, 100));
  await aliceServer.stop();
  await bobServer.stop();

  if (!aliceInboundReady) {
    throw new Error("alice inbound connection never finished handshake");
  }
  if (ready.peerName !== "alice") {
    throw new Error(`expected peerName=alice, got ${ready.peerName}`);
  }
  console.log("[smoke] PASS");
  process.exit(0);
}

main().catch((err) => {
  console.error("[smoke] FAIL:", err);
  process.exit(1);
});
