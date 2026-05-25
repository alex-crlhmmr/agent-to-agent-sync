// `peerd status` — show daemon health, TLS fingerprint, active calls.

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { ControlClient, peersTomlPath, readPeersToml, stateDir } from "../lib/peerd.js";

export async function cmdStatus(_args: string[]): Promise<number> {
  const t = readPeersToml();
  const sd = stateDir();
  console.log(`state dir:  ${sd}`);
  console.log(`peers.toml: ${peersTomlPath()}${fs.existsSync(peersTomlPath()) ? "" : "  (missing)"}`);
  console.log(`self:       ${t.self}`);
  console.log(`port:       ${t.port}`);
  console.log(`peers:      ${Object.keys(t.peers).length}`);

  const certPath = path.join(sd, "tls", "cert.pem");
  if (fs.existsSync(certPath)) {
    const cert = new crypto.X509Certificate(fs.readFileSync(certPath));
    const fp = "sha256/" + crypto.createHash("sha256").update(cert.raw).digest("hex");
    console.log(`fingerprint: ${fp}`);
  } else {
    console.log("fingerprint: (no cert yet; will generate on first daemon start)");
  }

  try {
    const client = await ControlClient.connect();
    try {
      const s = await client.call<{ calls: number; pending_invites: number }>("status", {}, { timeoutMs: 2000 });
      console.log("");
      console.log(`daemon:     ✔ running`);
      console.log(`active calls:    ${s.calls}`);
      console.log(`pending invites: ${s.pending_invites}`);
    } finally {
      client.close();
    }
  } catch {
    console.log("");
    console.log(`daemon:     ✘ not running. Start with \`npm run peerd\` (or install LaunchAgent).`);
  }
  return 0;
}
