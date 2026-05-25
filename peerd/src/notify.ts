// macOS notification helper used by peerd to ring the user on incoming invite.
// No-op on non-mac.

import { spawn } from "node:child_process";

function escape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function notify(opts: { title: string; message: string; subtitle?: string; sound?: string }): void {
  if (process.platform !== "darwin") return;
  const parts: string[] = [
    `display notification "${escape(opts.message)}"`,
    `with title "${escape(opts.title)}"`,
  ];
  if (opts.subtitle) parts.push(`subtitle "${escape(opts.subtitle)}"`);
  parts.push(`sound name "${escape(opts.sound ?? "Glass")}"`);
  const script = parts.join(" ");
  try {
    const child = spawn("osascript", ["-e", script], { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    /* silent */
  }
}
