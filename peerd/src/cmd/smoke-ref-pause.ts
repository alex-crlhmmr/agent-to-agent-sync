// Smoke: share_file_ref + fetch + pause/resume.
//
// Locks the contracts:
//   1. share_file_ref sends only metadata + small preview; full content stays
//      on sender side until receiver issues FETCH.
//   2. peer_fetch round-trips: FETCH → FETCH_RESPONSE; receiver gets full content;
//      sha256 matches.
//   3. share_file_ref transfers floor (consecutive returns OUT_OF_TURN).
//   4. peer_fetch does NOT transfer floor (out-of-turn frame at any time is fine).
//   5. peer_pause sets call.state to PAUSED on both sides; peer_resume returns
//      to CONNECTED. Either side can pause/resume regardless of floor.
//   6. peer_fetch with a non-existent ref → REF_UNAVAILABLE error.
//   7. share_file_ref content > 10 MiB rejected with REF_TOO_LARGE.

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
  const d = path.join(os.tmpdir(), `peerd-ref-${label}-${Date.now()}`);
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
    listLocalAvailable: () => [{ id: "smoke-only", subscribed_at: Date.now() }],
    isLocalSubscriberAvailable: (id) => id === "smoke-only",
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
  await writeToml(aliceDir, "alice", 17867, "bob", 17868, TOK_AB, TOK_BA);
  await writeToml(bobDir, "bob", 17868, "alice", 17867, TOK_BA, TOK_AB);
  const aliceTls = await ensureTls(aliceDir, "alice");
  const bobTls = await ensureTls(bobDir, "bob");
  await writeToml(aliceDir, "alice", 17867, "bob", 17868, TOK_AB, TOK_BA, bobTls.fingerprintSha256);
  await writeToml(bobDir, "bob", 17868, "alice", 17867, TOK_BA, TOK_AB, aliceTls.fingerprintSha256);

  const alice = await bootNode("alice", aliceDir);
  const bob = await bootNode("bob", bobDir);

  const conn = await dialPeer({ selfName: bob.config.self, peerName: "alice", peer: bob.config.peers["alice"] });
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("dial timeout")), 5000);
    conn.once("ready", () => { clearTimeout(t); resolve(); });
  });
  bob.connections.set("alice", conn);
  bob.cm.attachConnection(conn);
  await new Promise((r) => setTimeout(r, 100));

  alice.cm.on("invite", async (e: any) => { await alice.cm.acceptInvite(e.call_id); });

  const inv = await bob.cm.invite("alice", "ref+pause test");
  if (!inv.accepted) throw new Error("invite not accepted");
  const cid = inv.call_id;
  console.log(`[smoke-ref-pause] call established ${cid}`);

  // Track alice's events.
  const aliceEvents: Array<{ kind: string; payload: any }> = [];
  alice.cm.on("message", (evt: any) => aliceEvents.push({ kind: evt.kind, payload: evt.payload }));

  // ── Test 1: bob shares a 400 KiB file by ref → alice gets file_ref_shared with metadata only ──
  const bigContent = "X".repeat(400 * 1024);
  const expectedHash = crypto.createHash("sha256").update(bigContent).digest("hex");
  const shareRes = await bob.cm.shareFileRef(cid, {
    path: "lib/big.txt",
    content: bigContent,
    reason: "the full module",
    preview_chars: 200,
  });
  if (!shareRes.ref) throw new Error("missing ref_id in response");
  await new Promise((r) => setTimeout(r, 100));

  const refEvt = aliceEvents.find((e) => e.kind === "file_ref_shared");
  if (!refEvt) throw new Error("alice did not receive file_ref_shared");
  if (refEvt.payload.path !== "lib/big.txt") throw new Error("path mismatch");
  if (refEvt.payload.size_bytes !== bigContent.length) throw new Error(`size mismatch: ${refEvt.payload.size_bytes} vs ${bigContent.length}`);
  if (refEvt.payload.hash_sha256 !== expectedHash) throw new Error("hash mismatch");
  if (!refEvt.payload.ref) throw new Error("no ref in payload");
  if (refEvt.payload.preview && refEvt.payload.preview.length > 250) throw new Error("preview too long");
  // Critical: ensure FULL content is NOT inline in the event.
  if (refEvt.payload.content === bigContent) throw new Error("full content was inlined; should be ref-only");
  console.log(`[smoke-ref-pause] ✓ share_file_ref delivered metadata; ref=${refEvt.payload.ref}; full content NOT inline`);

  // ── Test 2: alice fetches the ref → gets the body ──
  const fetched = await alice.cm.fetchRef(cid, refEvt.payload.ref);
  if (fetched.content !== bigContent) throw new Error("fetched content mismatch");
  if (fetched.hash_sha256 !== expectedHash) throw new Error("fetched hash mismatch");
  console.log("[smoke-ref-pause] ✓ peer_fetch round-trip OK; content + hash match");

  // ── Test 3: turn-lock — bob can't share-ref again now (alice's turn) ──
  try {
    await bob.cm.shareFileRef(cid, { path: "y.txt", content: "y", reason: "y" });
    throw new Error("expected OUT_OF_TURN");
  } catch (e: any) {
    if (e.message !== "OUT_OF_TURN") throw new Error(`expected OUT_OF_TURN, got: ${e.message}`);
  }
  console.log("[smoke-ref-pause] ✓ share_file_ref transfers floor (consecutive returns OUT_OF_TURN)");

  // ── Test 4: alice CAN still peer_fetch at any time (not floor-locked) ──
  // (verifying she didn't lose the right to fetch even if it's bob's turn now…
  //  set floor to caller, alice is callee, so she's NOT on floor.)
  // Send a quick SEND from alice to flip floor.
  await alice.cm.send(cid, "thx for the file");
  // Now floor is on bob. Alice should still be able to fetch.
  const fetched2 = await alice.cm.fetchRef(cid, refEvt.payload.ref);
  if (fetched2.content !== bigContent) throw new Error("second fetch mismatch");
  console.log("[smoke-ref-pause] ✓ peer_fetch is NOT floor-locked (works off-turn)");

  // ── Test 5: pause + resume ──
  await bob.cm.pause(cid, { reason: "running local tests", eta_seconds: 30 });
  await new Promise((r) => setTimeout(r, 50));
  const aliceCall = alice.cm.getCall(cid);
  if (!aliceCall || aliceCall.state !== "PAUSED") throw new Error(`alice state after pause: ${aliceCall?.state}`);
  const bobCall = bob.cm.getCall(cid);
  if (!bobCall || bobCall.state !== "PAUSED") throw new Error(`bob state after pause: ${bobCall?.state}`);
  console.log("[smoke-ref-pause] ✓ pause: both sides now state=PAUSED");

  // Either side can pause regardless of floor (verified by allowing it). Now resume from the OTHER side:
  await alice.cm.resumeCall(cid);
  await new Promise((r) => setTimeout(r, 50));
  if (alice.cm.getCall(cid)?.state !== "CONNECTED") throw new Error(`alice state after resume: ${alice.cm.getCall(cid)?.state}`);
  if (bob.cm.getCall(cid)?.state !== "CONNECTED") throw new Error(`bob state after resume: ${bob.cm.getCall(cid)?.state}`);
  console.log("[smoke-ref-pause] ✓ resume: both sides back to CONNECTED (any side can resume)");

  // ── Test 6: fetch a non-existent ref → REF_UNAVAILABLE ──
  try {
    await alice.cm.fetchRef(cid, "ref_does_not_exist");
    throw new Error("expected REF_UNAVAILABLE");
  } catch (e: any) {
    if (!e.message.includes("REF_UNAVAILABLE")) throw new Error(`expected REF_UNAVAILABLE, got: ${e.message}`);
  }
  console.log("[smoke-ref-pause] ✓ fetch unknown ref returns REF_UNAVAILABLE");

  // ── Test 7: share_file_ref content > 10 MiB rejected ──
  try {
    const huge = "X".repeat(11 * 1024 * 1024);
    await bob.cm.shareFileRef(cid, { path: "huge", content: huge, reason: "too big" });
    throw new Error("expected REF_TOO_LARGE");
  } catch (e: any) {
    if (!e.message.includes("REF_TOO_LARGE")) throw new Error(`expected REF_TOO_LARGE, got: ${e.message}`);
  }
  console.log("[smoke-ref-pause] ✓ share_file_ref rejects >10 MiB content with REF_TOO_LARGE");

  // Teardown.
  await bob.cm.end(cid, { reason: "agreement_reached" });
  await new Promise((r) => setTimeout(r, 50));
  conn.close();
  await alice.controlServer.stop(); await bob.controlServer.stop();
  await alice.peerServer.stop(); await bob.peerServer.stop();
  console.log("[smoke-ref-pause] PASS");
  process.exit(0);
}

main().catch((err) => {
  console.error("[smoke-ref-pause] FAIL:", err);
  process.exit(1);
});
