// M2 smoke: verify peer-check-inbox and peer-status-line scripts behave correctly
// against a running peerd. Does NOT modify the real ~/.claude — uses ephemeral state dirs.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.js";
import { ensureTls } from "../tls.js";
import { PeerServer } from "../server.js";
import { CallManager } from "../call_manager.js";
import { ControlServer } from "../control.js";
import { dialPeer } from "../client.js";
import type { Connection } from "../connection.js";

const TOKEN_AB = "tok_ab";
const TOKEN_BA = "tok_ba";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const CHECK_INBOX = path.join(REPO_ROOT, "peer-mcp", "dist", "check_inbox.js");
const STATUS_LINE = path.join(REPO_ROOT, "peer-mcp", "dist", "status_line.js");

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
  const d = path.join(os.tmpdir(), `peerd-m2-${label}-${Date.now()}`);
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
  const controlServer = new ControlServer({ socketPath: config.controlSocketPath, cm });
  await controlServer.start();
  return { name, config, peerServer, controlServer, cm, connections };
}

async function runScript(scriptPath: string, sock: string, stdin: string): Promise<{ stdout: string; stderr: string; status: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      env: { ...process.env, PEERD_CONTROL_SOCK: sock, PEERD_CHECK_INBOX_VERBOSE: "1" } as Record<string, string>,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = ""; let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => { stdout += d; });
    child.stderr.on("data", (d: string) => { stderr += d; });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`runScript: ${scriptPath} timed out`));
    }, 10_000);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, status: status ?? -1 });
    });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.stdin.write(stdin);
    child.stdin.end();
  });
}

async function main() {
  // Pre-flight: the compiled scripts must exist.
  for (const p of [CHECK_INBOX, STATUS_LINE]) {
    if (!fs.existsSync(p)) {
      console.error(`[smoke-stop] missing ${p}. Run "npm run build" first.`);
      process.exit(2);
    }
  }

  const aliceDir = await freshDir("alice");
  const bobDir   = await freshDir("bob");

  await writeToml(aliceDir, "alice", 17817, "bob",   17818, TOKEN_AB, TOKEN_BA);
  await writeToml(bobDir,   "bob",   17818, "alice", 17817, TOKEN_BA, TOKEN_AB);
  const aliceTls = await ensureTls(aliceDir, "alice");
  const bobTls   = await ensureTls(bobDir,   "bob");
  await writeToml(aliceDir, "alice", 17817, "bob",   17818, TOKEN_AB, TOKEN_BA, bobTls.fingerprintSha256);
  await writeToml(bobDir,   "bob",   17818, "alice", 17817, TOKEN_BA, TOKEN_AB, aliceTls.fingerprintSha256);

  const alice = await bootNode("alice", aliceDir);
  const bob   = await bootNode("bob",   bobDir);

  // Establish the WSS link bob -> alice.
  const c = await dialPeer({
    selfName: bob.config.self, peerName: "alice",
    peer: bob.config.peers["alice"],
  });
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("dial timeout")), 5000);
    c.once("ready", () => { clearTimeout(t); resolve(); });
  });
  bob.connections.set("alice", c);
  bob.cm.attachConnection(c);
  await new Promise((r) => setTimeout(r, 100));

  // ── Test 1: peer-check-inbox with NO pending invites ─────────
  let res = await runScript(CHECK_INBOX, alice.config.controlSocketPath, JSON.stringify({
    session_id: "test-session-1",
    transcript_path: "/tmp/xx",
  }));
  if (res.stdout.trim() !== "") {
    throw new Error(`expected empty stdout when no invite, got: ${res.stdout}`);
  }
  console.log("[smoke-stop] ✓ peer-check-inbox quiet when inbox empty");

  // ── Set up: bob invites alice, leave it pending ──────────────
  const invitePromise = bob.cm.invite("alice", "User schema sync", {
    caller_label: "bob@layer-b",
    context_excerpt: "Confirming field types.",
  });
  await new Promise((r) => setTimeout(r, 500)); // give the invite time to reach alice

  const aliceCallsNow = alice.cm.listCalls();
  console.log(`[smoke-stop] alice calls after invite: ${aliceCallsNow.length} (${aliceCallsNow.map(c => c.state).join(",")})`);

  // Probe the inbox directly via control socket to confirm ControlServer has it.
  const { ControlClient } = await import("../control_client.js");
  const probe = await ControlClient.connect(alice.config.controlSocketPath);
  const probeInbox = await probe.call<{ invites: any[] }>("list_inbox", {});
  console.log(`[smoke-stop] direct list_inbox probe sees ${probeInbox.invites.length} invite(s)`);
  probe.close();

  // ── Test 2: peer-check-inbox WITH pending invite ─────────────
  res = await runScript(CHECK_INBOX, alice.config.controlSocketPath, JSON.stringify({
    session_id: "test-session-2",
  }));
  if (res.stderr) console.error(`[smoke-stop] check-inbox stderr: ${res.stderr}`);
  if (!res.stdout) throw new Error(`empty stdout despite pending invite (stderr: ${res.stderr})`);
  const parsed = JSON.parse(res.stdout);
  if (!parsed.hookSpecificOutput?.additionalContext?.includes("📞 You have pending peer call")) {
    throw new Error(`unexpected banner JSON: ${res.stdout}`);
  }
  if (!parsed.hookSpecificOutput.additionalContext.includes("User schema sync")) {
    throw new Error(`banner missing topic: ${res.stdout}`);
  }
  console.log("[smoke-stop] ✓ peer-check-inbox emits banner JSON when invite pending");
  console.log("           banner: " + parsed.hookSpecificOutput.additionalContext.split("\n")[0]);

  // ── Test 3: peer-status-line during RINGING ──────────────────
  res = await runScript(STATUS_LINE, alice.config.controlSocketPath, JSON.stringify({}));
  if (!res.stdout.includes("ringing") || !res.stdout.includes("@bob")) {
    throw new Error(`expected ringing-state status line, got: "${res.stdout}"`);
  }
  console.log("[smoke-stop] ✓ peer-status-line shows ringing: " + res.stdout.trim());

  // ── Test 4: accept the invite, then check status line shows the call ─
  // Find alice's call_id (the RINGING one)
  const aliceCalls = alice.cm.listCalls();
  const ringing = aliceCalls.find((c) => c.state === "RINGING");
  if (!ringing) throw new Error("expected one RINGING call on alice");
  await alice.cm.acceptInvite(ringing.call_id);
  await invitePromise; // resolve bob's side
  await new Promise((r) => setTimeout(r, 50));

  res = await runScript(STATUS_LINE, alice.config.controlSocketPath, JSON.stringify({}));
  if (!res.stdout.includes("📞") || !res.stdout.includes("@bob")) {
    throw new Error(`status line missing call info: "${res.stdout}"`);
  }
  console.log("[smoke-stop] ✓ peer-status-line shows active call: " + res.stdout.trim());

  // ── Test 5: invite is no longer in inbox after accept ─────────
  res = await runScript(CHECK_INBOX, alice.config.controlSocketPath, JSON.stringify({}));
  if (res.stdout.trim() !== "") {
    throw new Error(`expected empty stdout after accept, got: ${res.stdout}`);
  }
  console.log("[smoke-stop] ✓ peer-check-inbox quiet after invite accepted");

  // ── End and tear down ─────────────────────────────────────────
  await bob.cm.end(ringing.call_id, { reason: "agreement_reached" });
  await new Promise((r) => setTimeout(r, 50));

  for (const c of alice.connections.values()) c.close();
  for (const c of bob.connections.values()) c.close();
  await alice.controlServer.stop();
  await bob.controlServer.stop();
  await alice.peerServer.stop();
  await bob.peerServer.stop();

  console.log("[smoke-stop] PASS");
  process.exit(0);
}

main().catch((err) => {
  console.error("[smoke-stop] FAIL:", err);
  process.exit(1);
});
