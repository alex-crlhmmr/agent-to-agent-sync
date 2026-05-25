// Smoke: peer_share_file + peer_propose_change end-to-end.
//
// Locks the contract:
//   1. shareFile sends {path, content, language?, reason, hash_sha256}
//      over wire; receiver's recv() returns { kind: "file_shared", payload }.
//   2. proposeChange sends {target_file, diff, rationale, requires_human_approval}
//      over wire; receiver's recv() returns { kind: "change_proposed", payload }.
//   3. Both transfer the floor to the peer (turn-lock; consecutive shareFile
//      from same side returns OUT_OF_TURN).
//   4. Content > 256 KiB is rejected before send with INLINE_TOO_LARGE.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { loadConfig } from "../config.js";
import { ensureTls } from "../tls.js";
import { PeerServer } from "../server.js";
import { CallManager } from "../call_manager.js";
import { ControlServer } from "../control.js";
import { dialPeer } from "../client.js";
import type { Connection } from "../connection.js";

async function freshDir(label: string): Promise<string> {
  const d = path.join(os.tmpdir(), `peerd-share-${label}-${Date.now()}`);
  await fs.promises.rm(d, { recursive: true, force: true });
  await fs.promises.mkdir(d, { recursive: true });
  return d;
}

async function writeToml(dir: string, self: string, port: number, peerName: string, peerPort: number, ourOut: string, ourIn: string, fp?: string) {
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
  if (fp) lines.push(`fingerprint = "${fp}"`);
  await fs.promises.writeFile(path.join(dir, "peers.toml"), lines.join("\n") + "\n");
}

async function bootNode(name: string, dir: string) {
  const config = await loadConfig({ stateDir: dir });
  const tls = await ensureTls(dir, name);
  const connections = new Map<string, Connection>();
  const cm = new CallManager({
    selfName: config.self,
    stateDir: config.stateDir,
    getConnection: (peer) => connections.get(peer),
    // Test bypass: pretend one fake session is always available.
    listLocalAvailable: () => [{ id: "share-test", subscribed_at: Date.now() }],
    isLocalSubscriberAvailable: (id) => id === "share-test",
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
  await peerServer.start();
  const controlServer = new ControlServer({ socketPath: config.controlSocketPath, cm, config, getConnection: (p) => connections.get(p) });
  await controlServer.start();
  return { name, config, peerServer, controlServer, cm, connections };
}

async function main() {
  const TOK_AB = "tok_ab"; const TOK_BA = "tok_ba";
  const aliceDir = await freshDir("alice");
  const bobDir = await freshDir("bob");
  await writeToml(aliceDir, "alice", 17857, "bob", 17858, TOK_AB, TOK_BA);
  await writeToml(bobDir, "bob", 17858, "alice", 17857, TOK_BA, TOK_AB);
  const aliceTls = await ensureTls(aliceDir, "alice");
  const bobTls = await ensureTls(bobDir, "bob");
  await writeToml(aliceDir, "alice", 17857, "bob", 17858, TOK_AB, TOK_BA, bobTls.fingerprintSha256);
  await writeToml(bobDir, "bob", 17858, "alice", 17857, TOK_BA, TOK_AB, aliceTls.fingerprintSha256);

  const alice = await bootNode("alice", aliceDir);
  const bob = await bootNode("bob", bobDir);

  // Bob dials alice.
  const conn = await dialPeer({ selfName: bob.config.self, peerName: "alice", peer: bob.config.peers["alice"] });
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("dial timeout")), 5000);
    conn.once("ready", () => { clearTimeout(t); resolve(); });
  });
  bob.connections.set("alice", conn);
  bob.cm.attachConnection(conn);
  await new Promise((r) => setTimeout(r, 100));
  console.log("[smoke-share] WSS link up");

  // Auto-accept alice side.
  alice.cm.on("invite", async (e: any) => {
    await alice.cm.acceptInvite(e.call_id);
  });

  // Bob invites alice.
  const inv = await bob.cm.invite("alice", "share test");
  if (!inv.accepted) throw new Error("invite not accepted");
  const cid = inv.call_id;
  console.log(`[smoke-share] call established ${cid}`);

  // Track what alice received.
  const aliceReceived: Array<{ kind: string; payload: any }> = [];
  alice.cm.on("message", (evt: any) => {
    aliceReceived.push({ kind: evt.kind, payload: evt.payload });
  });

  // ── Test 1: bob (caller, holds floor) shares a file → alice gets file_shared ──
  const fileContent = `export interface User {\n  id: string;\n  email: string;\n  ts: string; // RFC3339\n}\n`;
  await bob.cm.shareFile(cid, {
    path: "schemas/user.ts",
    content: fileContent,
    language: "typescript",
    reason: "here's my User shape — does it fit your ingest?",
  });
  await new Promise((r) => setTimeout(r, 100));
  const fileEvt = aliceReceived.find((e) => e.kind === "file_shared");
  if (!fileEvt) throw new Error("alice did not receive file_shared");
  if (fileEvt.payload.path !== "schemas/user.ts") throw new Error("path mismatch");
  if (fileEvt.payload.content !== fileContent) throw new Error("content mismatch");
  if (fileEvt.payload.language !== "typescript") throw new Error("language mismatch");
  if (!fileEvt.payload.hash_sha256) throw new Error("missing hash_sha256");
  const expectedHash = crypto.createHash("sha256").update(fileContent).digest("hex");
  if (fileEvt.payload.hash_sha256 !== expectedHash) throw new Error("hash mismatch");
  console.log("[smoke-share] ✓ peer_share_file delivered with content + hash + language");

  // ── Test 2: turn-lock — bob can't share again immediately (alice has floor) ──
  try {
    await bob.cm.shareFile(cid, { path: "x.ts", content: "x", reason: "x" });
    throw new Error("expected OUT_OF_TURN on consecutive share");
  } catch (e: any) {
    if (e.message !== "OUT_OF_TURN") throw new Error(`expected OUT_OF_TURN, got: ${e.message}`);
  }
  console.log("[smoke-share] ✓ shareFile transfers floor (OUT_OF_TURN on consecutive)");

  // ── Test 3: alice proposes a change back to bob ──
  const bobReceived: Array<{ kind: string; payload: any }> = [];
  bob.cm.on("message", (evt: any) => {
    bobReceived.push({ kind: evt.kind, payload: evt.payload });
  });
  const diff = `@@ -3,1 +3,1 @@\n- ts: string; // RFC3339\n+ ts: string; // RFC3339 with millisecond precision\n`;
  await alice.cm.proposeChange(cid, {
    target_file: "schemas/user.ts",
    diff,
    rationale: "tighten ts to millisecond precision, since we round-trip via JS Date",
    requires_human_approval: true,
  });
  await new Promise((r) => setTimeout(r, 100));
  const changeEvt = bobReceived.find((e) => e.kind === "change_proposed");
  if (!changeEvt) throw new Error("bob did not receive change_proposed");
  if (changeEvt.payload.target_file !== "schemas/user.ts") throw new Error("target_file mismatch");
  if (changeEvt.payload.diff !== diff) throw new Error("diff mismatch");
  if (!changeEvt.payload.rationale.includes("millisecond")) throw new Error("rationale missing");
  if (changeEvt.payload.requires_human_approval !== true) throw new Error("requires_human_approval should be true");
  console.log("[smoke-share] ✓ peer_propose_change delivered with diff + rationale + gate flag");

  // ── Test 4: file > 256 KiB rejected client-side with INLINE_TOO_LARGE ──
  try {
    const huge = "x".repeat(257 * 1024);
    await bob.cm.shareFile(cid, { path: "huge.txt", content: huge, reason: "too big" });
    throw new Error("expected INLINE_TOO_LARGE");
  } catch (e: any) {
    if (!e.message.includes("INLINE_TOO_LARGE")) throw new Error(`expected INLINE_TOO_LARGE, got: ${e.message}`);
  }
  console.log("[smoke-share] ✓ peer_share_file rejects content > 256 KiB with INLINE_TOO_LARGE");

  // ── Test 5: end + verify transcripts contain SHARE_FILE / PROPOSE_CHANGE frames ──
  await bob.cm.end(cid, { reason: "agreement_reached", agreement: { summary: "schema ok" } });
  await new Promise((r) => setTimeout(r, 100));

  const bobTranscript = await fs.promises.readFile(path.join(bobDir, "calls", cid, "transcript.jsonl"), "utf8");
  if (!bobTranscript.includes('"SHARE_FILE"')) throw new Error("bob transcript missing SHARE_FILE");
  if (!bobTranscript.includes('"PROPOSE_CHANGE"')) throw new Error("bob transcript missing PROPOSE_CHANGE");
  const aliceTranscript = await fs.promises.readFile(path.join(aliceDir, "calls", cid, "transcript.jsonl"), "utf8");
  if (!aliceTranscript.includes('"SHARE_FILE"')) throw new Error("alice transcript missing SHARE_FILE");
  if (!aliceTranscript.includes('"PROPOSE_CHANGE"')) throw new Error("alice transcript missing PROPOSE_CHANGE");
  console.log("[smoke-share] ✓ SHARE_FILE + PROPOSE_CHANGE persisted to transcript on both sides");

  // Teardown
  conn.close();
  await alice.controlServer.stop(); await bob.controlServer.stop();
  await alice.peerServer.stop(); await bob.peerServer.stop();
  console.log("[smoke-share] PASS");
  process.exit(0);
}

main().catch((err) => {
  console.error("[smoke-share] FAIL:", err);
  process.exit(1);
});
