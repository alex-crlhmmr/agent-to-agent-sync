// Smoke test: full call lifecycle.
// Spins up two peerds, connects them, exchanges INVITE/ACCEPT/SEND/SEND/END,
// verifies transcripts + artifacts.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig } from "../config.js";
import { ensureTls } from "../tls.js";
import { PeerServer } from "../server.js";
import { dialPeer } from "../client.js";
import { CallManager, InviteEvent, CallMessageEvent } from "../call_manager.js";
import type { Connection } from "../connection.js";
import type { SendPayload } from "../types.js";

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
  stateDir: string;
  server: PeerServer;
  cm: CallManager;
  connections: Map<string, Connection>;
}

async function bootNode(name: string, stateDir: string): Promise<PeerdNode> {
  const config = await loadConfig({ stateDir });
  const tls = await ensureTls(stateDir, name);
  const server = new PeerServer({ config, tls });
  const connections = new Map<string, Connection>();
  const cm = new CallManager({
    selfName: config.self,
    stateDir: config.stateDir,
    getConnection: (peer) => connections.get(peer),
    // Smoke test driving CallManager directly — bypass the opt-in gate by
    // pretending there's always one available subscriber.
    listLocalAvailable: () => [{ id: "smoke-only", subscribed_at: Date.now() }],
    isLocalSubscriberAvailable: (id) => id === "smoke-only",
  });

  server.on("connection", (conn: Connection) => {
    conn.once("ready", (info: { peerName: string }) => {
      connections.set(info.peerName, conn);
      cm.attachConnection(conn);
    });
    conn.once("close", () => {
      for (const [k, v] of connections) if (v === conn) connections.delete(k);
    });
  });

  await server.start();
  return { name, stateDir, server, cm, connections };
}

async function dialAndRegister(node: PeerdNode, targetName: string): Promise<Connection> {
  const config = await loadConfig({ stateDir: node.stateDir });
  const conn = await dialPeer({
    selfName: config.self,
    peerName: targetName,
    peer: config.peers[targetName],
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
  const aliceDir = await freshStateDir("alice-call");
  const bobDir = await freshStateDir("bob-call");

  // Initial peers.toml (no fingerprint yet)
  await writePeerToml(aliceDir, "alice", 17787, "bob",   17788, TOKEN_AB, TOKEN_BA);
  await writePeerToml(bobDir,   "bob",   17788, "alice", 17787, TOKEN_BA, TOKEN_AB);

  // Generate TLS to get fingerprints, then rewrite with pins
  const aliceTls = await ensureTls(aliceDir, "alice");
  const bobTls   = await ensureTls(bobDir,   "bob");
  await writePeerToml(aliceDir, "alice", 17787, "bob",   17788, TOKEN_AB, TOKEN_BA, bobTls.fingerprintSha256);
  await writePeerToml(bobDir,   "bob",   17788, "alice", 17787, TOKEN_BA, TOKEN_AB, aliceTls.fingerprintSha256);

  const alice = await bootNode("alice", aliceDir);
  const bob   = await bootNode("bob",   bobDir);
  console.log(`[smoke-call] both servers up`);

  // Bob dials Alice
  await dialAndRegister(bob, "alice");
  // Give Alice's side time to register the inbound connection
  await new Promise((r) => setTimeout(r, 100));
  if (!alice.connections.has("bob")) {
    throw new Error("alice did not register bob's inbound connection");
  }

  // Alice auto-accepts any invite
  const aliceMessages: CallMessageEvent[] = [];
  alice.cm.on("invite", async (evt: InviteEvent) => {
    console.log(`[alice] incoming invite from ${evt.from} re: "${evt.topic}"; auto-accepting`);
    await alice.cm.acceptInvite(evt.call_id);
  });
  alice.cm.on("message", (evt: CallMessageEvent) => {
    console.log(`[alice] received ${evt.kind} from ${evt.from}: ${JSON.stringify(evt.payload).slice(0, 120)}`);
    aliceMessages.push(evt);
  });
  alice.cm.on("ended", (evt: any) => {
    console.log(`[alice] call ended by=${evt.by}`);
  });

  // Bob tracks what comes back from Alice
  const bobMessages: CallMessageEvent[] = [];
  bob.cm.on("message", (evt: CallMessageEvent) => {
    console.log(`[bob] received ${evt.kind} from ${evt.from}: ${JSON.stringify(evt.payload).slice(0, 120)}`);
    bobMessages.push(evt);
  });

  // Bob invites Alice
  const inv = await bob.cm.invite("alice", "User schema sync", {
    caller_label: "bob@layer-b",
    context_excerpt: "I need to confirm field types for the User contract.",
  });
  console.log(`[smoke-call] invite resolved: accepted=${inv.accepted} call=${inv.call_id}`);
  if (!inv.accepted) throw new Error("invite was not accepted");

  // Bob has the floor first. Sends a message.
  await bob.cm.send(inv.call_id, "I'll emit User{id: ULID, email: string, ts: int64 unix-ms}. OK?");

  // Wait for Alice to receive it
  await new Promise((r) => setTimeout(r, 80));

  // Alice now has the floor. Send a reply on alice's side via her CallManager.
  const aliceCalls = alice.cm.listCalls();
  if (aliceCalls.length !== 1) throw new Error(`alice should have 1 call, got ${aliceCalls.length}`);
  const aliceCall = aliceCalls[0];
  await alice.cm.send(aliceCall.call_id, "ts as RFC3339 string, not unix-ms. Otherwise fine.");

  await new Promise((r) => setTimeout(r, 80));

  // Bob now has the floor. Send another message.
  await bob.cm.send(inv.call_id, "Got it, switching to RFC3339.");

  await new Promise((r) => setTimeout(r, 80));

  // Verify turn-lock: bob attempts to send again out of turn (he just sent, Alice has floor)
  try {
    await bob.cm.send(inv.call_id, "(out-of-turn attempt)");
    throw new Error("expected OUT_OF_TURN on consecutive send");
  } catch (e: any) {
    if (e.message !== "OUT_OF_TURN") throw e;
    console.log(`[smoke-call] turn-lock OK: bob blocked from consecutive sends`);
  }

  // Bob ends the call with structured agreement + action items
  const endResult = await bob.cm.end(inv.call_id, {
    reason: "agreement_reached",
    agreement: {
      summary: "User schema uses RFC3339 strings for timestamps.",
      decisions: [
        { topic: "User.ts", decision: "{ id: ULID, email: string, ts: RFC3339 string }" },
      ],
    },
    action_items: [
      { owner: "bob",   task: "implement User emitter with RFC3339", due: "2026-05-25" },
      { owner: "alice", task: "tighten ingest validator", due: "2026-05-25" },
    ],
  });
  console.log(`[smoke-call] bob ended call; artifacts: ${endResult.artifacts?.map(a => a.kind).join(",")}`);

  await new Promise((r) => setTimeout(r, 100));

  // Verify both sides have transcripts + artifacts
  const bobTranscriptPath = path.join(bobDir, "calls", inv.call_id, "transcript.jsonl");
  const aliceTranscriptPath = path.join(aliceDir, "calls", inv.call_id, "transcript.jsonl");
  const bobArtifacts = path.join(bobDir, "calls", inv.call_id, "artifacts");

  const bobLines = (await fs.promises.readFile(bobTranscriptPath, "utf8")).trim().split("\n").length;
  const aliceLines = (await fs.promises.readFile(aliceTranscriptPath, "utf8")).trim().split("\n").length;
  console.log(`[smoke-call] transcript lines: bob=${bobLines} alice=${aliceLines}`);

  const agreementMd = await fs.promises.readFile(path.join(bobArtifacts, "agreement.md"), "utf8");
  const actionItemsMd = await fs.promises.readFile(path.join(bobArtifacts, "action_items.md"), "utf8");
  console.log(`[smoke-call] agreement.md (${agreementMd.length} bytes), action_items.md (${actionItemsMd.length} bytes) written`);

  // Tear down
  for (const c of alice.connections.values()) c.close();
  for (const c of bob.connections.values()) c.close();
  await alice.server.stop();
  await bob.server.stop();

  // Sanity assertions
  if (bobMessages.length < 1) throw new Error("bob received no messages");
  if (aliceMessages.length < 2) throw new Error("alice should have received at least 2 SENDs");

  console.log("[smoke-call] PASS");
  process.exit(0);
}

main().catch((err) => {
  console.error("[smoke-call] FAIL:", err);
  process.exit(1);
});
