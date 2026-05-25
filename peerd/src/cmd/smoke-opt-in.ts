// Smoke test: opt-in receive + session discovery + targeted call.
//
// Validates the new protocol:
//   1. Peer subscribers default to available=false (NOT routable).
//   2. peer_list_remote_sessions returns only available sessions (with metadata).
//   3. peer_invite with target_session_id routes ONLY to that session.
//   4. If target_session_id no longer matches an available session, invite
//      fails fast with NO_SUCH_SESSION (no fallback to other sessions).
//
// This file is the contract for the production code.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig } from "../config.js";
import { ensureTls } from "../tls.js";
import { PeerServer } from "../server.js";
import { CallManager } from "../call_manager.js";
import { ControlServer } from "../control.js";
import { dialPeer } from "../client.js";
import { ControlClient } from "../control_client.js";
import type { Connection } from "../connection.js";

const TOKEN_AB = "tok_ab";
const TOKEN_BA = "tok_ba";

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
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(path.join(dir, "peers.toml"), lines.join("\n") + "\n");
}

async function freshDir(label: string): Promise<string> {
  const d = path.join(os.tmpdir(), `peerd-optin-${label}-${Date.now()}`);
  await fs.promises.rm(d, { recursive: true, force: true });
  await fs.promises.mkdir(d, { recursive: true });
  return d;
}

async function bootNode(name: string, dir: string) {
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
  await peerServer.start();
  const controlServer = new ControlServer({
    socketPath: config.controlSocketPath,
    cm,
    config,
    getConnection: (peer) => connections.get(peer),
  });
  // Wire opt-in subscriber accessors (mirrors production index.ts).
  cm.setSubscriberAccessors({
    listLocalAvailable: () => controlServer.listAvailableSessions().map((s) => ({
      id: s.id, label: s.label, cwd: s.cwd, subscribed_at: s.subscribed_at,
    })),
    isLocalSubscriberAvailable: (id) => {
      const s = controlServer.getSubscriber(id);
      return Boolean(s && s.available);
    },
  });
  await controlServer.start();
  return { name, config, peerServer, controlServer, cm, connections, tls };
}

async function main() {
  const aliceDir = await freshDir("alice");
  const bobDir = await freshDir("bob");

  // Pre-pair (TLS fingerprints exchanged)
  await writeToml(aliceDir, "alice", 17847, "bob", 17848, TOKEN_AB, TOKEN_BA);
  await writeToml(bobDir, "bob", 17848, "alice", 17847, TOKEN_BA, TOKEN_AB);
  const aliceTls = await ensureTls(aliceDir, "alice");
  const bobTls = await ensureTls(bobDir, "bob");
  await writeToml(aliceDir, "alice", 17847, "bob", 17848, TOKEN_AB, TOKEN_BA, bobTls.fingerprintSha256);
  await writeToml(bobDir, "bob", 17848, "alice", 17847, TOKEN_BA, TOKEN_AB, aliceTls.fingerprintSha256);

  const alice = await bootNode("alice", aliceDir);
  const bob = await bootNode("bob", bobDir);

  // Bob dials alice.
  const conn = await dialPeer({
    selfName: bob.config.self,
    peerName: "alice",
    peer: bob.config.peers["alice"],
  });
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("dial timeout")), 5000);
    conn.once("ready", () => { clearTimeout(t); resolve(); });
  });
  bob.connections.set("alice", conn);
  bob.cm.attachConnection(conn);
  await new Promise((r) => setTimeout(r, 100));
  console.log("[smoke-opt-in] both peerds + WSS link up");

  // Three "subscribers" on alice — simulating 3 claude code sessions.
  const aliceC1 = await ControlClient.connect(alice.config.controlSocketPath);
  const aliceC2 = await ControlClient.connect(alice.config.controlSocketPath);
  const aliceC3 = await ControlClient.connect(alice.config.controlSocketPath);

  // A single subscribe per client with an event sink we'll inspect throughout the test.
  interface SubSink { id?: string; inviteEvents: any[]; }
  function subscribeWithSink(c: typeof aliceC1): { sink: SubSink; ready: Promise<void> } {
    const sink: SubSink = { inviteEvents: [] };
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("subscribe timeout")), 3000);
      c.subscribe("subscribe_inbox", {}, (n: any) => {
        if (n?.kind === "subscribed") {
          sink.id = n.payload.subscriber_id;
          clearTimeout(timer);
          resolve();
          return;
        }
        if (n?.kind === "invite") {
          sink.inviteEvents.push(n);
        }
      });
    });
    return { sink, ready };
  }
  const s1Bind = subscribeWithSink(aliceC1);
  const s2Bind = subscribeWithSink(aliceC2);
  const s3Bind = subscribeWithSink(aliceC3);
  await Promise.all([s1Bind.ready, s2Bind.ready, s3Bind.ready]);
  const sub1 = { subscriber_id: s1Bind.sink.id! };
  const sub2 = { subscriber_id: s2Bind.sink.id! };
  const sub3 = { subscriber_id: s3Bind.sink.id! };
  console.log(`[smoke-opt-in] alice has 3 subscribers: ${sub1.subscriber_id}, ${sub2.subscriber_id}, ${sub3.subscriber_id}`);

  // ── Test 1: list_remote_sessions when none are available → 0 results ──
  {
    const bobC = await ControlClient.connect(bob.config.controlSocketPath);
    const res = await bobC.call<{ sessions: any[] }>("list_remote_sessions", { peer: "alice" }, { timeoutMs: 5000 });
    if (res.sessions.length !== 0) throw new Error(`expected 0 available sessions, got ${res.sessions.length}`);
    bobC.close();
    console.log("[smoke-opt-in] ✓ list_remote_sessions returns 0 when none available");
  }

  // ── Test 2: invite when none available → NO_AVAILABLE_SESSIONS ──
  {
    const bobC = await ControlClient.connect(bob.config.controlSocketPath);
    const res = await bobC.call<{ accepted: boolean; reason?: string }>("invite", {
      peer: "alice", topic: "test",
    }, { timeoutMs: 10_000 });
    if (res.accepted) throw new Error("expected invite to fail when no sessions available");
    if (!res.reason?.includes("NO_AVAILABLE_SESSIONS")) {
      throw new Error(`expected NO_AVAILABLE_SESSIONS reason, got: ${res.reason}`);
    }
    bobC.close();
    console.log("[smoke-opt-in] ✓ invite fails with NO_AVAILABLE_SESSIONS when no sessions available");
  }

  // ── Make subscribers 1 and 3 available (with labels), leave 2 unavailable ──
  await aliceC1.call("set_session_metadata", { subscriber_id: sub1.subscriber_id, available: true, label: "work", cwd: "/home/alice/projects/user-api" });
  await aliceC3.call("set_session_metadata", { subscriber_id: sub3.subscriber_id, available: true, label: "idle", cwd: "/home/alice" });
  // sub2 left at default (available=false)

  // ── Test 3: list_remote_sessions returns only available subs ──
  let sessionList: any[];
  {
    const bobC = await ControlClient.connect(bob.config.controlSocketPath);
    const res = await bobC.call<{ sessions: any[] }>("list_remote_sessions", { peer: "alice" }, { timeoutMs: 5000 });
    sessionList = res.sessions;
    if (sessionList.length !== 2) throw new Error(`expected 2 available sessions, got ${sessionList.length}: ${JSON.stringify(sessionList)}`);
    const labels = sessionList.map((s) => s.label).sort();
    if (labels[0] !== "idle" || labels[1] !== "work") throw new Error(`unexpected labels: ${labels.join(",")}`);
    bobC.close();
    console.log(`[smoke-opt-in] ✓ list_remote_sessions returns 2 sessions: ${JSON.stringify(labels)}`);
  }

  // ── Test 4: targeted invite to a specific session → that session gets the invite ──
  const workSession = sessionList.find((s) => s.label === "work");
  if (!workSession) throw new Error("missing work session");
  const workSubId = workSession.id;

  // Clear inviteEvents on each sink before the targeted invite test.
  s1Bind.sink.inviteEvents.length = 0;
  s2Bind.sink.inviteEvents.length = 0;
  s3Bind.sink.inviteEvents.length = 0;

  // Bob invites alice's "work" session specifically.
  // We don't wait for accept; we just want to see who gets the popup.
  const bobC = await ControlClient.connect(bob.config.controlSocketPath);
  const invitePromise = bobC.call<{ accepted: boolean; call_id?: string }>("invite", {
    peer: "alice", topic: "schema sync", target_session_id: workSubId,
    invite_timeout_s: 5,
  }, { timeoutMs: 15_000 });
  await new Promise((r) => setTimeout(r, 300));

  const sub1GotInvite = s1Bind.sink.inviteEvents.some((n) => !n.silent);
  const sub3GotInvite = s3Bind.sink.inviteEvents.some((n) => !n.silent);
  if (!sub1GotInvite) throw new Error("expected sub1 (work) to receive the popup");
  if (sub3GotInvite) throw new Error("sub3 (idle) should NOT have received a non-silent popup");
  console.log("[smoke-opt-in] ✓ targeted invite delivered to sub1 (work) only, NOT to sub3 (idle)");

  // Let the invite time out for cleanup.
  const inviteResolution = await invitePromise;
  if (inviteResolution.accepted) throw new Error("invite shouldn't have been accepted (no one was driving sub1)");
  bobC.close();

  // ── Test 5: invite with target_session_id that doesn't exist → NO_SUCH_SESSION ──
  {
    const bobC2 = await ControlClient.connect(bob.config.controlSocketPath);
    const res = await bobC2.call<{ accepted: boolean; reason?: string }>("invite", {
      peer: "alice", topic: "fail test", target_session_id: "sub-does-not-exist",
      invite_timeout_s: 5,
    }, { timeoutMs: 10_000 });
    if (res.accepted) throw new Error("expected NO_SUCH_SESSION fail, got accepted");
    if (!res.reason?.includes("NO_SUCH_SESSION")) {
      throw new Error(`expected NO_SUCH_SESSION reason, got: ${res.reason}`);
    }
    bobC2.close();
    console.log("[smoke-opt-in] ✓ targeted invite to unknown session_id fails with NO_SUCH_SESSION");
  }

  // ── Test 6: make sub1 unavailable, then targeted invite fails too ──
  await aliceC1.call("set_session_metadata", { subscriber_id: sub1.subscriber_id, available: false });
  await new Promise((r) => setTimeout(r, 100));
  {
    const bobC3 = await ControlClient.connect(bob.config.controlSocketPath);
    const res = await bobC3.call<{ accepted: boolean; reason?: string }>("invite", {
      peer: "alice", topic: "fail test 2", target_session_id: workSubId,
      invite_timeout_s: 5,
    }, { timeoutMs: 10_000 });
    if (res.accepted) throw new Error("expected NO_SUCH_SESSION fail (sub went unavailable)");
    if (!res.reason?.includes("NO_SUCH_SESSION")) {
      throw new Error(`expected NO_SUCH_SESSION reason, got: ${res.reason}`);
    }
    bobC3.close();
    console.log("[smoke-opt-in] ✓ targeted invite fails when target session just went unavailable");
  }

  // Teardown
  aliceC1.close(); aliceC2.close(); aliceC3.close();
  conn.close();
  await alice.controlServer.stop(); await bob.controlServer.stop();
  await alice.peerServer.stop(); await bob.peerServer.stop();

  console.log("[smoke-opt-in] PASS");
  process.exit(0);
}

main().catch((err) => {
  console.error("[smoke-opt-in] FAIL:", err);
  process.exit(1);
});
