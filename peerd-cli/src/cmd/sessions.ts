// `peerd sessions` — show locally-opted-in claude sessions reachable for calls.

import { ControlClient } from "../lib/peerd.js";

export async function cmdSessions(_args: string[]): Promise<number> {
  let client: ControlClient;
  try {
    client = await ControlClient.connect();
  } catch {
    console.log("peerd: daemon not running. Start it with `npm run peerd`.");
    return 1;
  }
  try {
    const res = await client.call<{ sessions: any[] }>("list_local_sessions", {}, { timeoutMs: 2000 });
    const sessions = res.sessions ?? [];
    if (sessions.length === 0) {
      console.log("No local claude sessions are opted in to receive calls.");
      console.log("");
      console.log("Open claude and run /make-available-for-call to opt the session in.");
      console.log("Or launch with PEERD_AVAILABLE=1 claude (or PEERD_AVAILABLE=<label> claude).");
      return 0;
    }
    console.log(`${sessions.length} session(s) reachable for incoming calls:`);
    console.log("");
    const w = Math.max(...sessions.map((s) => (s.label ?? "(no label)").length), 8);
    console.log(`${"label".padEnd(w)}  cwd                                             started`);
    console.log(`${"".padEnd(w, "-")}  ----------------------------------------------  -------`);
    for (const s of sessions) {
      const label = (s.label ?? "(no label)").padEnd(w);
      const cwd = (s.cwd ?? "?").slice(0, 46).padEnd(46);
      const started = relTime(new Date(s.subscribed_at).toISOString());
      console.log(`${label}  ${cwd}  ${started}`);
    }
    return 0;
  } finally {
    client.close();
  }
}

function relTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "?";
  const secs = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}
