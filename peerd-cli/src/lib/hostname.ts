// Helpers for finding the hostname this machine should be reachable at.

import { spawnSync } from "node:child_process";
import * as os from "node:os";
import { IS_MAC, IS_WIN, whichSync } from "./platform.js";

/**
 * Try to find the most useful hostname for the local peerd. Preference:
 *   1. Tailscale MagicDNS (`tailscale status --json` -> Self.DNSName)
 *   2. system hostname (FQDN if possible; `<host>.local` on macOS)
 *
 * NOTE for Windows + cross-OS pairing: `<host>.local` mDNS resolution is
 * unreliable on Windows (no Bonjour by default). Prefer pairing via Tailscale
 * MagicDNS when one of the peers is on Windows.
 */
export function detectMyHostname(): string {
  // Try Tailscale first. whichSync handles Windows (`tailscale.exe`) too.
  const tsBin = whichSync("tailscale");
  if (tsBin) {
    try {
      const r = spawnSync(tsBin, ["status", "--json"], { encoding: "utf8" });
      if (r.status === 0 && r.stdout) {
        const parsed = JSON.parse(r.stdout);
        const dns = parsed?.Self?.DNSName;
        if (typeof dns === "string" && dns.length > 0) {
          // Tailscale's DNSName ends with a trailing dot; strip it.
          return dns.replace(/\.$/, "");
        }
      }
    } catch { /* tailscale not running */ }
  }

  // Fallback: system hostname. Append .local on macOS if no dot, since
  // mDNS makes that resolvable on the LAN. Don't do this on Windows: Bonjour
  // is often missing and `<host>.local` won't resolve from peers.
  let h = os.hostname();
  if (IS_MAC && !h.includes(".")) h = `${h}.local`;
  // On Windows, the bare hostname is what peers will need; Tailscale MagicDNS
  // (above) is the recommended path anyway.
  void IS_WIN; // silence unused
  return h;
}
