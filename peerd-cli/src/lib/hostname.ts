// Helpers for finding the hostname this machine should be reachable at.

import { spawnSync } from "node:child_process";
import * as os from "node:os";

/**
 * Try to find the most useful hostname for the local peerd. Preference:
 *   1. Tailscale MagicDNS (`tailscale status --json` -> Self.DNSName)
 *   2. system hostname (FQDN if possible)
 */
export function detectMyHostname(): string {
  // Try Tailscale first.
  try {
    const r = spawnSync("tailscale", ["status", "--json"], { encoding: "utf8" });
    if (r.status === 0 && r.stdout) {
      const parsed = JSON.parse(r.stdout);
      const dns = parsed?.Self?.DNSName;
      if (typeof dns === "string" && dns.length > 0) {
        // Tailscale's DNSName ends with a trailing dot; strip it.
        return dns.replace(/\.$/, "");
      }
    }
  } catch { /* tailscale not installed or not running */ }

  // Fallback: system hostname. Append .local on macOS if no dot, since
  // mDNS makes that resolvable on the LAN.
  let h = os.hostname();
  if (process.platform === "darwin" && !h.includes(".")) h = `${h}.local`;
  return h;
}
