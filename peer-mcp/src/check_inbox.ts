#!/usr/bin/env -S npx tsx
// peer-check-inbox — Claude Code Stop hook.
//
// Reads the Stop-hook JSON envelope from stdin, queries peerd for pending invites
// (and later: voicemails), prints an `additionalContext` banner when something is
// waiting, exits 0 silently otherwise.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PeerdClient } from "./peerd_client.js";

const SOCKET_PATH =
  process.env.PEERD_CONTROL_SOCK ??
  path.join(os.homedir(), ".claude", "peerd", "control.sock");

// Read JSON envelope on stdin (not strictly required to use it, but we drain it).
async function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let buf = "";
    process.stdin.on("data", (c) => { buf += c.toString("utf8"); });
    process.stdin.on("end", () => resolve(buf));
    // If stdin is a TTY (no piped JSON), end immediately.
    if (process.stdin.isTTY) resolve("");
  });
}

function relTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "just now";
  const secs = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  return `${Math.floor(secs / 3600)}h ago`;
}

async function main() {
  // Drain stdin (Claude Code sends the Stop-hook JSON here; we don't currently
  // need any of its fields, but consuming it cleanly avoids EPIPE on the parent).
  await readStdin();

  if (!fs.existsSync(SOCKET_PATH)) {
    // peerd isn't running; silently do nothing — we never want to break a turn.
    process.exit(0);
  }

  let client: PeerdClient;
  try {
    client = await PeerdClient.connect(SOCKET_PATH);
  } catch {
    process.exit(0);
  }

  try {
    const [inboxRes, callsRes] = await Promise.all([
      client.call<{ invites: any[] }>("list_inbox", {}, { timeoutMs: 2000 }),
      client.call<{ calls: any[] }>("list_calls", {}, { timeoutMs: 2000 }),
    ]);
    const invites = inboxRes.invites ?? [];
    const activeCalls = (callsRes.calls ?? []).filter((c) => c.state === "CONNECTED" || c.state === "PAUSED");

    if (invites.length === 0 && activeCalls.length === 0) {
      process.exit(0);
    }
    const lines: string[] = [];
    if (activeCalls.length > 0) {
      lines.push("📞 You have an active peer call — you need to drive it:");
      for (const c of activeCalls) {
        lines.push(
          `  • call_id ${c.call_id} with ${c.remote_peer} (floor=${c.floor})`,
        );
      }
      lines.push("");
      lines.push("If it's your turn (floor=callee for invitee, floor=caller for caller), call mcp__peerd__peer_recv with the call_id to receive the next message, then peer_send to reply. End with peer_end when an agreement is reached.");
    }
    if (invites.length > 0) {
      if (lines.length > 0) lines.push("");
      lines.push("📞 You have pending peer call(s):");
      for (const inv of invites) {
        lines.push(
          `  • from ${inv.from}@${inv.caller_label} — "${inv.topic}" (${relTime(inv.received_at)})`,
          `    call_id: ${inv.call_id}`,
        );
      }
      lines.push("");
      lines.push("The user is usually prompted via an inline accept/decline popup automatically. If a popup isn't shown, you can fall back to: peer_accept_invite with the call_id, then enter the recv/send loop. peer_deny_invite to decline.");
    }
    const banner = lines.join("\n");

    // Stop hooks use top-level `systemMessage` to surface info to the user/agent.
    // (`hookSpecificOutput.additionalContext` is valid for UserPromptSubmit / PostToolUse,
    // not Stop — Claude Code's runtime rejects the wrong shape.)
    const out = { systemMessage: banner };
    process.stdout.write(JSON.stringify(out) + "\n");
  } finally {
    client.close();
  }
}

main().catch((err) => {
  // Stop hook MUST NOT block the assistant; exit 0 but surface diagnostics to stderr.
  if (process.env.PEERD_CHECK_INBOX_VERBOSE) {
    console.error("[peer-check-inbox]", err?.stack ?? err?.message ?? String(err));
  }
  process.exit(0);
});
