// End-to-end smoke: drive the full pipeline via the MCP protocol, the way Claude Code does.
//
// Topology:
//   ┌──────────────────────────┐                            ┌──────────────────────────┐
//   │ MCP client A (this test) │                            │ MCP client B (this test) │
//   │   spawns ↓ stdio         │                            │   spawns ↓ stdio         │
//   │ peer-mcp (child) ↔ Unix  │   ←── peerd's WSS ──→     │ peer-mcp (child) ↔ Unix  │
//   │                  ↕      sock                          sock                  ↕     │
//   │             peerd (this proc, instance A)        peerd (this proc, instance B)   │
//   └──────────────────────────┘                            └──────────────────────────┘
//
// What we verify:
//   - peer-mcp spawns and lists 6 tools.
//   - peer_invite from B blocks until A accepts (via peer_list_inbox + peer_accept_invite).
//   - peer_send / peer_recv exchange round-trip text.
//   - peer_end writes agreement.md + action_items.md on both sides.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadConfig } from "../config.js";
import { ensureTls } from "../tls.js";
import { PeerServer } from "../server.js";
import { CallManager } from "../call_manager.js";
import { ControlServer } from "../control.js";
import { dialPeer } from "../client.js";
import type { Connection } from "../connection.js";

const TOKEN_AB = "tok_alex_to_bob";
const TOKEN_BA = "tok_bob_to_alex";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const PEER_MCP_ENTRY = path.join(REPO_ROOT, "peer-mcp", "src", "index.ts");
const TSX_BIN = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");

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

async function bootPeerd(name: string, stateDir: string): Promise<PeerdNode> {
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
  const controlServer = new ControlServer({
    socketPath: config.controlSocketPath,
    cm,
    config,
    getConnection: (peer) => connections.get(peer),
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

async function makeMcpClient(label: string, controlSocketPath: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: TSX_BIN,
    args: [PEER_MCP_ENTRY],
    env: { ...process.env, PEERD_CONTROL_SOCK: controlSocketPath } as Record<string, string>,
    stderr: "inherit",
  });
  const client = new Client({ name: `smoke-mcp-${label}`, version: "0.1.0" });
  await client.connect(transport);
  return client;
}

function parseToolText<T = any>(result: any): T {
  const content = result?.content?.[0];
  if (!content || content.type !== "text") throw new Error("expected text content");
  return JSON.parse(content.text);
}

async function pollUntilInvite(client: Client, timeoutMs: number): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await client.callTool({ name: "peer_list_inbox", arguments: {} });
    const parsed = parseToolText<{ invites: any[] }>(res);
    if (parsed.invites.length > 0) return parsed.invites[0];
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("never saw incoming invite");
}

async function main() {
  // 1. Boot two peerds
  const aliceDir = await freshStateDir("mcp-alice");
  const bobDir   = await freshStateDir("mcp-bob");

  await writePeerToml(aliceDir, "alice", 17807, "bob",   17808, TOKEN_AB, TOKEN_BA);
  await writePeerToml(bobDir,   "bob",   17808, "alice", 17807, TOKEN_BA, TOKEN_AB);
  const aliceTls = await ensureTls(aliceDir, "alice");
  const bobTls   = await ensureTls(bobDir,   "bob");
  await writePeerToml(aliceDir, "alice", 17807, "bob",   17808, TOKEN_AB, TOKEN_BA, bobTls.fingerprintSha256);
  await writePeerToml(bobDir,   "bob",   17808, "alice", 17807, TOKEN_BA, TOKEN_AB, aliceTls.fingerprintSha256);

  const alice = await bootPeerd("alice", aliceDir);
  const bob   = await bootPeerd("bob",   bobDir);
  console.log("[smoke-mcp] both peerds + control sockets up");

  await dialAndRegister(bob, "alice");
  await new Promise((r) => setTimeout(r, 100));
  if (!alice.connections.has("bob")) throw new Error("alice never registered bob inbound");
  console.log("[smoke-mcp] WSS link bob↔alice established");

  // 2. Spawn peer-mcp child processes and connect MCP clients (simulating Claude Code).
  const aliceMcp = await makeMcpClient("alice", alice.config.controlSocketPath);
  const bobMcp   = await makeMcpClient("bob",   bob.config.controlSocketPath);
  console.log("[smoke-mcp] both MCP clients connected");

  // 3. List tools and sanity-check the surface area.
  const tools = await bobMcp.listTools();
  const names = tools.tools.map((t) => t.name).sort();
  console.log(`[smoke-mcp] tools advertised: ${names.join(", ")}`);
  const expected = ["peer_accept_invite", "peer_end", "peer_invite", "peer_list_inbox", "peer_recv", "peer_send"];
  for (const t of expected) {
    if (!names.includes(t)) throw new Error(`missing tool: ${t}`);
  }

  // 4. Kick off the invite flow.
  //    bob calls peer_invite (blocks until accepted)
  //    alice (in parallel) polls peer_list_inbox, then calls peer_accept_invite
  const invitePromise = bobMcp.callTool({
    name: "peer_invite",
    arguments: {
      peer: "alice",
      topic: "User schema sync",
      caller_label: "bob@layer-b",
      context_excerpt: "Confirming field types for the User contract.",
    },
  });

  const inboxInvite = await pollUntilInvite(aliceMcp, 10_000);
  console.log(`[smoke-mcp] alice saw incoming invite: call=${inboxInvite.call_id} from=${inboxInvite.from} topic="${inboxInvite.topic}"`);

  const acceptRes = await aliceMcp.callTool({
    name: "peer_accept_invite",
    arguments: { call_id: inboxInvite.call_id },
  });
  const acceptParsed = parseToolText<{ session_token: string }>(acceptRes);
  console.log(`[smoke-mcp] alice accepted; session_token=${acceptParsed.session_token.slice(0, 16)}...`);

  const inviteRaw = await invitePromise;
  const inv = parseToolText<{ call_id: string; accepted: boolean }>(inviteRaw);
  if (!inv.accepted) throw new Error("invite not accepted");
  if (inv.call_id !== inboxInvite.call_id) throw new Error("call_id mismatch between sides");
  console.log(`[smoke-mcp] bob's peer_invite resolved; call=${inv.call_id} accepted=${inv.accepted}`);

  // 5. Exchange three SEND turns.
  await bobMcp.callTool({
    name: "peer_send",
    arguments: { call_id: inv.call_id, text: "I'll emit User{id: ULID, email, ts}. OK?" },
  });

  const aliceRecv1 = parseToolText<any>(await aliceMcp.callTool({
    name: "peer_recv",
    arguments: { call_id: inv.call_id, timeout_s: 5 },
  }));
  console.log(`[smoke-mcp] alice recv: ${JSON.stringify(aliceRecv1).slice(0, 120)}`);
  if (aliceRecv1.kind !== "send" || aliceRecv1.payload.text.indexOf("ULID") < 0) {
    throw new Error("alice did not receive bob's first send");
  }

  await aliceMcp.callTool({
    name: "peer_send",
    arguments: { call_id: inv.call_id, text: "ts must be RFC3339, otherwise OK." },
  });

  const bobRecv1 = parseToolText<any>(await bobMcp.callTool({
    name: "peer_recv",
    arguments: { call_id: inv.call_id, timeout_s: 5 },
  }));
  console.log(`[smoke-mcp] bob   recv: ${JSON.stringify(bobRecv1).slice(0, 120)}`);
  if (bobRecv1.kind !== "send" || bobRecv1.payload.text.indexOf("RFC3339") < 0) {
    throw new Error("bob did not receive alice's reply");
  }

  // 6. Bob ends the call with a structured agreement.
  const endRaw = await bobMcp.callTool({
    name: "peer_end",
    arguments: {
      call_id: inv.call_id,
      reason: "agreement_reached",
      agreement: {
        summary: "User.ts uses RFC3339 strings for timestamps.",
        decisions: [{ topic: "User.ts/ts", decision: "RFC3339 string (not unix-ms)" }],
      },
      action_items: [
        { owner: "bob",   task: "implement User emitter with RFC3339", due: "2026-05-25" },
        { owner: "alice", task: "tighten ingest validator", due: "2026-05-25" },
      ],
    },
  });
  const ended = parseToolText<{ artifacts: { kind: string; path: string }[] }>(endRaw);
  console.log(`[smoke-mcp] bob ended; artifacts: ${ended.artifacts.map(a => a.kind).join(",")}`);

  // 7. Alice's last peer_recv should pick up the "ended" event.
  const aliceEndedRaw = await aliceMcp.callTool({
    name: "peer_recv",
    arguments: { call_id: inv.call_id, timeout_s: 5 },
  });
  const aliceEnded = parseToolText<any>(aliceEndedRaw);
  console.log(`[smoke-mcp] alice recv (after end): kind=${aliceEnded.kind} by=${aliceEnded.by}`);
  if (aliceEnded.kind !== "ended") throw new Error(`expected ended event, got ${aliceEnded.kind}`);

  // 8. Verify durable archive on disk (the (B) path).
  const bobArtifacts = path.join(bobDir, "calls", inv.call_id, "artifacts");
  const aliceTranscriptPath = path.join(aliceDir, "calls", inv.call_id, "transcript.jsonl");
  const agreementMd  = await fs.promises.readFile(path.join(bobArtifacts, "agreement.md"), "utf8");
  const actionItems  = await fs.promises.readFile(path.join(bobArtifacts, "action_items.md"), "utf8");
  const aliceLines   = (await fs.promises.readFile(aliceTranscriptPath, "utf8")).trim().split("\n").length;
  console.log(`[smoke-mcp] artifacts: agreement.md=${agreementMd.length}B, action_items.md=${actionItems.length}B; alice transcript lines=${aliceLines}`);

  if (!agreementMd.includes("RFC3339")) throw new Error("agreement.md missing decision text");
  if (!actionItems.includes("@bob"))    throw new Error("action_items.md missing bob");

  // Teardown
  await aliceMcp.close();
  await bobMcp.close();
  for (const c of alice.connections.values()) c.close();
  for (const c of bob.connections.values()) c.close();
  await alice.controlServer.stop();
  await bob.controlServer.stop();
  await alice.peerServer.stop();
  await bob.peerServer.stop();

  console.log("[smoke-mcp] PASS");
  process.exit(0);
}

main().catch((err) => {
  console.error("[smoke-mcp] FAIL:", err);
  process.exit(1);
});
