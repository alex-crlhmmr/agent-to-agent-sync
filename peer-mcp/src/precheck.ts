#!/usr/bin/env -S npx tsx
// peer-precheck — Claude Code UserPromptSubmit hook.
//
// Runs BEFORE the agent processes the user's prompt. Checks peerd for active
// calls and pending invites, and (if any) emits `additionalContext` that lands
// in the agent's input — instructing it to drive the call. This is how a
// freshly accepted ambient call gets pulled into the agent's conversation
// without the user having to remember any special command.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PeerdClient } from "./peerd_client.js";

const SOCKET_PATH =
  process.env.PEERD_CONTROL_SOCK ??
  path.join(os.homedir(), ".claude", "peerd", "control.sock");

async function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let buf = "";
    process.stdin.on("data", (c) => { buf += c.toString("utf8"); });
    process.stdin.on("end", () => resolve(buf));
    if (process.stdin.isTTY) resolve("");
  });
}

function appendLog(msg: string): void {
  try {
    const dir = path.join(os.homedir(), ".claude", "peerd");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "peer-precheck.log"), `[${new Date().toISOString()}] ${msg}\n`);
  } catch { /* ignore */ }
}

async function main() {
  await readStdin();
  appendLog(`fired; socket=${SOCKET_PATH}`);
  if (!fs.existsSync(SOCKET_PATH)) {
    appendLog("socket missing, exiting 0");
    process.exit(0);
  }

  let client: PeerdClient;
  try {
    client = await PeerdClient.connect(SOCKET_PATH);
  } catch {
    process.exit(0);
  }

  try {
    const [calls, inbox] = await Promise.all([
      client.call<{ calls: any[] }>("list_calls", {}, { timeoutMs: 2000 }),
      client.call<{ invites: any[] }>("list_inbox", {}, { timeoutMs: 2000 }),
    ]);
    const active = (calls.calls ?? []).filter((c) => c.state === "CONNECTED" || c.state === "PAUSED");
    const invites = inbox.invites ?? [];
    appendLog(`active=${active.length} invites=${invites.length}`);
    if (active.length === 0 && invites.length === 0) {
      appendLog("nothing to inject, exiting 0");
      process.exit(0);
    }

    const lines: string[] = [];
    if (active.length > 0) {
      lines.push("**[peerd]** You have one or more active peer calls. Drive them BEFORE answering anything else the user said:");
      for (const c of active) {
        const myFloor = c.is_local_caller === false /* fallback if absent */ ? "callee" : (c.floor === "callee" ? "callee" : "caller");
        const hint = c.floor === "callee"
          ? "Bob's message is queued — call `mcp__peerd__peer_recv` now with this call_id."
          : "It's your turn to send. Call `mcp__peerd__peer_send` with a reply.";
        lines.push(`  • call_id ${c.call_id} with ${c.remote_peer}, state=${c.state}, floor=${c.floor}. ${hint}`);
      }
      lines.push("");
      lines.push("Loop: peer_recv → reason → peer_send → peer_recv → ... until either side calls `peer_end`. If you reach an agreement, you call peer_end with structured `agreement` + `action_items`.");
    }
    if (invites.length > 0) {
      if (lines.length > 0) lines.push("");
      lines.push("**[peerd]** Pending incoming peer invites (the user is usually prompted via an inline popup — if for some reason they weren't, you can fall back to using these tools):");
      for (const inv of invites) {
        lines.push(`  • from ${inv.from} — "${inv.topic}" (call_id ${inv.call_id})`);
      }
      lines.push("");
      lines.push("To accept programmatically: call `mcp__peerd__peer_accept_invite` with the call_id, then start the recv/send loop. To decline: `mcp__peerd__peer_deny_invite`.");
    }

    const out = {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: lines.join("\n"),
      },
    };
    const json = JSON.stringify(out);
    appendLog(`emitting additionalContext (${json.length} bytes)`);
    process.stdout.write(json + "\n");
  } finally {
    client.close();
  }
}

main().catch((err) => {
  if (process.env.PEERD_CHECK_INBOX_VERBOSE) console.error("[peer-precheck]", err?.stack ?? err?.message ?? String(err));
  process.exit(0);
});
