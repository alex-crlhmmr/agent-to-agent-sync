import * as crypto from "node:crypto";
import type { TLSSocket } from "node:tls";
import WebSocket from "ws";
import { Connection } from "./connection.js";
import type { PeerEntry } from "./config.js";

const SUBPROTOCOL = "peerd.v1";

export interface DialOptions {
  selfName: string;
  peerName: string;
  peer: PeerEntry;
}

export async function dialPeer(opts: DialOptions): Promise<Connection> {
  const { selfName, peerName, peer } = opts;
  const url = `wss://${peer.host}:${peer.port}/`;

  const ws = new WebSocket(url, [SUBPROTOCOL], {
    headers: {
      "X-Peerd-Version": "1",
      "X-Peerd-From": selfName,
      "X-Peerd-Token": peer.token,
    },
    rejectUnauthorized: false,
    handshakeTimeout: 10_000,
  });

  return new Promise((resolve, reject) => {
    let settled = false;

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      try { ws.terminate(); } catch { /* ignore */ }
      reject(err);
    };

    ws.on("upgrade", (res) => {
      try {
        const sock = (res as any).socket as TLSSocket;
        if (!sock || typeof sock.getPeerCertificate !== "function") return;
        const cert = sock.getPeerCertificate(true);
        if (!cert || !cert.raw) {
          fail(new Error("peer cert missing"));
          return;
        }
        const fp = "sha256/" + crypto.createHash("sha256").update(cert.raw).digest("hex");
        if (peer.fingerprint && peer.fingerprint !== fp) {
          fail(new Error(`TLS fingerprint mismatch for ${peerName}: expected ${peer.fingerprint}, got ${fp}`));
          return;
        }
        if (!peer.fingerprint) {
          // TOFU mode (first connection) — accept and warn; the operator can pin it after.
          console.warn(`[peerd] no pinned fingerprint for ${peerName}; saw ${fp} (consider pinning).`);
        }
      } catch (e) {
        fail(e as Error);
      }
    });

    ws.on("open", () => {
      if (settled) return;
      settled = true;
      const conn = new Connection({
        ws,
        role: "client",
        selfName,
        expectedPeerName: peerName,
      });
      resolve(conn);
    });

    ws.on("error", (err: Error) => fail(err));
    ws.on("close", () => fail(new Error("closed before open")));
  });
}
