// Smoke test: drive a full call entirely through the local control socket,
// simulating what peer-mcp (or peer-cli) will do.
//
// Layout:
//   alice (peerd #1, control.sock #1) <==== WSS ====> bob (peerd #2, control.sock #2)
//   alice's "shim" (this script's client A)            bob's "shim" (client B)

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

interface PeerdNode {
  name: string;
  config: Awaited<ReturnType<typeof loadConfig>>;
  peerServer: PeerServer;
  controlServer: ControlServer;
  cm: CallManager;
  connections: Map<string, Connection>;
}

async function bootNode(name: string, stateDir: string): Promise<PeerdNode> {
  const config = await loadConfig({ stateDir });
  const tls = await ensureTls(stateDir, name);
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
  const controlServer = new ControlServer({ socketPath: config.controlSocketPath, cm });
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
  return { name, config, peerServer, controlServer, cm, connections };
}

async function dialAndRegister(node: PeerdNode, targetName: string): Promise<Connection> {
  const conn = await dialPeer({
    selfName: node.config.self,
    peerName: targetName,
    peer: node.config.peers[targetName],
  });
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("dial handshake timeout")), 5000);
    conn.once("ready", () => { clearTimeout(t); resolve(); });
    conn.once("error", (e: Error) => { clearTimeout(t); reject(e); });
  });
  node.connections.set(targetName, conn);
  node.cm.attachConnection(conn);
  return conn;
}

async function main() {
  const aliceDir = await freshStateDir("ctrl-alice");
  const bobDir = await freshStateDir("ctrl-bob");

  await writePeerToml(aliceDir, "alice", 17797, "bob",   17798, TOKEN_AB, TOKEN_BA);
  await writePeerToml(bobDir,   "bob",   17798, "alice", 17797, TOKEN_BA, TOKEN_AB);
  const aliceTls = await ensureTls(aliceDir, "alice");
  const bobTls   = await ensureTls(bobDir,   "bob");
  await writePeerToml(aliceDir, "alice", 17797, "bob",   17798, TOKEN_AB, TOKEN_BA, bobTls.fingerprintSha256);
  await writePeerToml(bobDir,   "bob",   17798, "alice", 17797, TOKEN_BA, TOKEN_AB, aliceTls.fingerprintSha256);

  const alice = await bootNode("alice", aliceDir);
  const bob   = await bootNode("bob",   bobDir);
  console.log(`[smoke-ctrl] both peerds + control sockets up`);

  await dialAndRegister(bob, "alice");
  await new Promise((r) => setTimeout(r, 100));
  if (!alice.connections.has("bob")) throw new Error("alice missing inbound bob conn");

  // Two "shim" clients (one for each side).
  const aliceClient = await ControlClient.connect(alice.config.controlSocketPath);
  const bobClient   = await ControlClient.connect(bob.config.controlSocketPath);

  // Alice's shim subscribes to incoming invites and auto-accepts.
  const aliceInvites: any[] = [];
  let aliceSubscriberId: string | null = null;
  const subReady = new Promise<void>((resolve) => {
    aliceClient.subscribe("subscribe_inbox", {}, async (n: any) => {
      if (n.kind === "subscribed") {
        aliceSubscriberId = n.payload?.subscriber_id ?? null;
        resolve();
        return;
      }
      if (n.kind === "invite") {
        aliceInvites.push(n.payload);
        console.log(`[alice-shim] incoming invite ${n.payload.call_id} from ${n.payload.from} re: "${n.payload.topic}"`);
        try {
          const result = await aliceClient.call("accept_invite", { call_id: n.payload.call_id });
          console.log(`[alice-shim] accepted; session_token=${(result as any).session_token?.slice(0, 16)}...`);
        } catch (e: any) {
          console.log(`[alice-shim] accept failed: ${e.message}`);
        }
      }
    });
  });
  await subReady;
  // Make alice available so bob's invite isn't rejected.
  await aliceClient.call("set_session_metadata", { subscriber_id: aliceSubscriberId, available: true });

  // Give the subscribe round-trip a moment to register on the server side.
  await new Promise((r) => setTimeout(r, 50));

  // Bob's shim invites Alice.
  const inv = await bobClient.call<{ call_id: string; accepted: boolean; reason?: string }>(
    "invite",
    { peer: "alice", topic: "User schema sync", caller_label: "bob@layer-b" },
    { timeoutMs: 60_000 },
  );
  console.log(`[bob-shim] invite resolved: accepted=${inv.accepted} call=${inv.call_id}`);
  if (!inv.accepted) throw new Error("invite not accepted");

  // Now drive the conversation. Bob has the floor first.
  await bobClient.call("send", { call_id: inv.call_id, text: "I'll emit User{id, email, ts}. Cool?" });

  // Alice's shim should `recv` to get the message. Since recv is per-call, alice needs the call_id.
  // Alice's shim discovered the call_id via the subscribe notification.
  const aliceCallId = aliceInvites[0]?.call_id;
  if (!aliceCallId) throw new Error("alice shim never saw the invite");
  const recv1 = await aliceClient.call<any>("recv", { call_id: aliceCallId, timeout_s: 5 });
  console.log(`[alice-shim] recv: ${JSON.stringify(recv1).slice(0, 140)}`);

  // Alice replies.
  await aliceClient.call("send", { call_id: aliceCallId, text: "ts must be RFC3339, otherwise OK." });
  const recv2 = await bobClient.call<any>("recv", { call_id: inv.call_id, timeout_s: 5 });
  console.log(`[bob-shim] recv: ${JSON.stringify(recv2).slice(0, 140)}`);

  // Bob ends the call with an agreement.
  const endResult = await bobClient.call<any>("end", {
    call_id: inv.call_id,
    reason: "agreement_reached",
    agreement: {
      summary: "User.ts uses RFC3339 strings for timestamps.",
      decisions: [{ topic: "User.ts/ts", decision: "RFC3339 string" }],
    },
    action_items: [{ owner: "bob", task: "implement RFC3339 emitter", due: "2026-05-25" }],
  });
  console.log(`[bob-shim] ended; artifacts: ${endResult.artifacts?.map((a: any) => a.kind).join(",")}`);

  // Alice's recv should pick up the `ended` event.
  const ended = await aliceClient.call<any>("recv", { call_id: aliceCallId, timeout_s: 5 });
  console.log(`[alice-shim] recv (after end): ${JSON.stringify(ended).slice(0, 140)}`);
  if (ended.kind !== "ended") throw new Error(`expected ended event, got ${ended.kind}`);

  // Tear down
  aliceClient.close();
  bobClient.close();
  for (const c of alice.connections.values()) c.close();
  for (const c of bob.connections.values()) c.close();
  await alice.controlServer.stop();
  await bob.controlServer.stop();
  await alice.peerServer.stop();
  await bob.peerServer.stop();

  console.log("[smoke-ctrl] PASS");
  process.exit(0);
}

main().catch((err) => {
  console.error("[smoke-ctrl] FAIL:", err);
  process.exit(1);
});
