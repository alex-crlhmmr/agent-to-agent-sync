#!/usr/bin/env -S npx tsx
// peer-status — Claude Code status-line component.
//
// Stdin: Claude Code JSON envelope (session_id, model, cwd, etc.) — we don't use it.
// Stdout: a single line if a call is active; nothing otherwise.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PeerdClient } from "./peerd_client.js";

const SOCKET_PATH =
  process.env.PEERD_CONTROL_SOCK ??
  path.join(os.homedir(), ".claude", "peerd", "control.sock");

async function readStdin(): Promise<void> {
  return new Promise((resolve) => {
    process.stdin.on("data", () => {});
    process.stdin.on("end", () => resolve());
    if (process.stdin.isTTY) resolve();
  });
}

function fmtDuration(startedAt: string): string {
  const ms = Math.max(0, Date.now() - Date.parse(startedAt));
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

async function main() {
  await readStdin();
  if (!fs.existsSync(SOCKET_PATH)) {
    process.exit(0);
  }
  let client: PeerdClient;
  try {
    client = await PeerdClient.connect(SOCKET_PATH);
  } catch {
    process.exit(0);
  }
  try {
    const res = await client.call<{ calls: any[] }>("list_calls", {}, { timeoutMs: 1500 });
    const active = (res.calls ?? []).filter((c) => c.state === "CONNECTED" || c.state === "DIALING" || c.state === "RINGING" || c.state === "PAUSED");
    if (active.length === 0) {
      process.exit(0);
    }
    const c = active[0];
    const dur = fmtDuration(c.started_at);
    const stateGlyph = c.state === "CONNECTED" ? "📞" :
                       c.state === "DIALING"   ? "📞 dialing" :
                       c.state === "RINGING"   ? "📞 ringing" :
                       c.state === "PAUSED"    ? "⏸  paused" : "📞";
    process.stdout.write(`${stateGlyph} @${c.remote_peer} · ${dur} · floor=${c.floor}\n`);
  } finally {
    client.close();
  }
}

main().catch(() => process.exit(0));
