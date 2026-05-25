// `peerd pair <hostname>` — pair with the peerd at <hostname>.
//
// Protocol:
//   1. Ask local peerd: get_self → {name, port, fingerprint}
//   2. Generate a fresh outgoing token (what the remote will require from us going forward).
//   3. POST {our name/host/port/token/fingerprint} to https://<hostname>:7777/pair
//   4. Remote (in pairing mode, after `peerd ready`) responds with its credentials.
//   5. Tell local peerd: add_peer → writes peers.toml + starts the outbound dial loop.

import * as crypto from "node:crypto";
import * as https from "node:https";
import { ControlClient } from "../lib/peerd.js";
import { detectMyHostname } from "../lib/hostname.js";

interface PairResponse {
  name: string;
  port: number;
  token: string;
  fingerprint: string;
}

export async function cmdPair(args: string[]): Promise<number> {
  let host = "";
  let port = 7777;
  let myHost = "";
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--port") {
      port = Number(args[++i]);
    } else if (a === "--my-host") {
      myHost = args[++i];
    } else if (!host) {
      host = a;
    }
  }
  if (!host) {
    console.error("usage: peerd pair <hostname> [--port N] [--my-host <our-hostname>]");
    return 2;
  }
  if (!myHost) myHost = detectMyHostname();

  const client = await ControlClient.connect().catch(() => {
    throw new Error("can't reach local peerd. Is it running? Try `npm run peerd`.");
  });

  let self: { name: string; port: number; fingerprint: string };
  try {
    self = await client.call("get_self", {}, { timeoutMs: 3000 });
  } catch (e: any) {
    client.close();
    throw new Error(`local peerd doesn't support get_self: ${e?.message ?? e}`);
  }

  const ourOutgoingToken = "sk_peer_" + crypto.randomBytes(24).toString("hex");

  const body = {
    name: self.name,
    host: myHost,
    port: self.port,
    token: ourOutgoingToken,
    fingerprint: self.fingerprint,
  };

  console.log(`peerd: pairing with ${host}:${port} as "${self.name}" (host=${myHost})…`);

  let resp: PairResponse;
  try {
    resp = await postJson<PairResponse>(`https://${host}:${port}/pair`, body, 30_000);
  } catch (e: any) {
    client.close();
    if (e?.message?.includes("503")) {
      throw new Error(
        `remote not in pairing mode. Tell your teammate to run \`peerd ready\` on their machine, then retry.`,
      );
    }
    throw new Error(`pair POST failed: ${e?.message ?? e}`);
  }

  // Write our own peers.toml entry.
  try {
    const ok = await client.call<{ ok: boolean }>("add_peer", {
      name: resp.name,
      host,
      port: resp.port,
      outgoing_token: ourOutgoingToken,
      inbound_token: resp.token,
      fingerprint: resp.fingerprint,
    }, { timeoutMs: 5000 });
    if (!ok.ok) throw new Error("local add_peer returned ok=false");
  } finally {
    client.close();
  }

  console.log("");
  console.log(`✔ paired with "${resp.name}" at ${host}:${resp.port}`);
  console.log(`  fingerprint: ${resp.fingerprint}`);
  console.log("");
  console.log("Both sides have updated peers.toml. peerd is auto-dialing now.");
  console.log("Open Claude Code and try:  call " + resp.name + " about <topic>");
  return 0;
}

/** POST JSON body to a self-signed-https URL; accept any cert (TOFU pair). */
function postJson<T>(url: string, body: unknown, timeoutMs: number): Promise<T> {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  return new Promise<T>((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        method: "POST",
        host: u.hostname,
        port: u.port ? Number(u.port) : 443,
        path: u.pathname + (u.search || ""),
        headers: {
          "Content-Type": "application/json",
          "Content-Length": payload.length,
        },
        rejectUnauthorized: false, // TOFU at pair time — fingerprint is in the response
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode !== 200) {
            return reject(new Error(`${res.statusCode} ${res.statusMessage}: ${raw.slice(0, 200)}`));
          }
          try {
            resolve(JSON.parse(raw) as T);
          } catch (e: any) {
            reject(new Error(`bad JSON response: ${e?.message ?? e}`));
          }
        });
      },
    );
    req.on("timeout", () => { req.destroy(new Error("request timeout")); });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}
