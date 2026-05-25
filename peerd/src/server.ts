import { EventEmitter } from "node:events";
import * as https from "node:https";
import * as http from "node:http";
import * as crypto from "node:crypto";
import { WebSocketServer } from "ws";
import { Connection } from "./connection.js";
import type { Config } from "./config.js";
import type { TlsMaterial } from "./tls.js";

const SUBPROTOCOL = "peerd.v1";
const PAIR_BODY_MAX = 64 * 1024;

/** Successful pair handshake — emitted so the daemon can persist + hot-load the peer. */
export interface PairCompleted {
  /** Peer's self-declared name (becomes the local key in peers.toml). */
  peer_name: string;
  /** Peer's host (we record what the request claimed; for TOFU pairing, this is best-effort). */
  peer_host: string;
  /** Peer's listen port. */
  peer_port: number;
  /** The token THEY will present TO US on future WSS upgrades (their outgoing → our inbound). */
  peer_outgoing_token: string;
  /** The token WE must present TO THEM on future WSS upgrades (our outgoing → their inbound). */
  our_outgoing_token: string;
  /** Peer's TLS fingerprint, to be pinned. */
  peer_fingerprint: string;
}

export interface PeerServerOptions {
  config: Config;
  tls: TlsMaterial;
}

export class PeerServer extends EventEmitter {
  private httpsServer?: https.Server;
  private wss?: WebSocketServer;
  private config: Config;
  private tls: TlsMaterial;
  private pairExpiresAt = 0;

  constructor(opts: PeerServerOptions) {
    super();
    this.config = opts.config;
    this.tls = opts.tls;
  }

  /** Enable pairing mode for `seconds`. Returns the deadline (epoch ms). */
  enterPairingMode(seconds: number): number {
    this.pairExpiresAt = Date.now() + Math.max(5, seconds) * 1000;
    return this.pairExpiresAt;
  }

  exitPairingMode(): void {
    this.pairExpiresAt = 0;
  }

  isPairing(): boolean {
    return this.pairExpiresAt > Date.now();
  }

  async start(): Promise<void> {
    this.httpsServer = https.createServer({
      cert: this.tls.certPem,
      key: this.tls.keyPem,
    });

    this.wss = new WebSocketServer({
      noServer: true,
      handleProtocols: (protocols: Set<string>) => (protocols.has(SUBPROTOCOL) ? SUBPROTOCOL : false),
      maxPayload: 1 * 1024 * 1024,
    });

    // ── HTTP request handler for non-WS routes (currently just /pair) ────────
    this.httpsServer.on("request", (req, res) => {
      if (req.method === "POST" && req.url === "/pair") {
        this.handlePairRequest(req, res).catch((e) => {
          this.emit("error", e);
          try { res.statusCode = 500; res.end(JSON.stringify({ error: "INTERNAL_ERROR", message: String(e?.message ?? e) })); } catch {}
        });
        return;
      }
      res.statusCode = 404;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "NOT_FOUND" }));
    });

    // ── WS upgrade handler (normal in-call traffic) ─────────────────────────
    this.httpsServer.on("upgrade", (req, socket, head) => {
      const headers = req.headers;
      const version = String(headers["x-peerd-version"] ?? "");
      const fromName = String(headers["x-peerd-from"] ?? "");
      const token = String(headers["x-peerd-token"] ?? "");

      if (version !== "1") {
        socket.write("HTTP/1.1 426 Upgrade Required\r\nWWW-Authenticate: Peerd error=\"UNSUPPORTED_VERSION\"\r\n\r\n");
        socket.destroy();
        return;
      }
      if (!fromName || !token) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Peerd error=\"AUTH_FAILED\"\r\n\r\n");
        socket.destroy();
        return;
      }

      const peer = this.config.peers[fromName];
      const expectedToken = peer?.inboundToken ?? peer?.token;
      if (!peer || !expectedToken || token !== expectedToken) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Peerd error=\"AUTH_FAILED\"\r\n\r\n");
        socket.destroy();
        return;
      }

      this.wss!.handleUpgrade(req, socket, head, (ws) => {
        const conn = new Connection({
          ws,
          role: "server",
          selfName: this.config.self,
          expectedPeerName: fromName,
        });
        this.emit("connection", conn);
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.httpsServer!.once("error", reject);
      this.httpsServer!.listen(this.config.port, () => {
        this.httpsServer!.off("error", reject);
        resolve();
      });
    });
  }

  private async handlePairRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!this.isPairing()) {
      res.statusCode = 503;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "NOT_IN_PAIRING_MODE", message: "Run `peerd ready` first." }));
      return;
    }

    // Drain body with size cap.
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += b.length;
      if (total > PAIR_BODY_MAX) {
        res.statusCode = 413;
        res.end(JSON.stringify({ error: "BODY_TOO_LARGE" }));
        return;
      }
      chunks.push(b);
    }
    const raw = Buffer.concat(chunks).toString("utf8");

    let body: any;
    try {
      body = JSON.parse(raw);
    } catch {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "INVALID_JSON" }));
      return;
    }

    const peerName = String(body.name ?? "");
    const peerHost = String(body.host ?? "");
    const peerPort = Number(body.port ?? 7777);
    const peerToken = String(body.token ?? "");
    const peerFingerprint = String(body.fingerprint ?? "");
    if (!peerName || !peerHost || !peerToken || !peerFingerprint) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "INVALID_REQUEST", message: "name, host, token, fingerprint required" }));
      return;
    }
    if (peerName === this.config.self) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "INVALID_REQUEST", message: "peer name equals our self name" }));
      return;
    }

    // Generate the token we'll require FROM the peer on future WSS connects.
    // The peer will store this as their `token` (their outgoing); we store it
    // as our `inbound_token`.
    const ourOutgoingToken = randomToken();

    const evt: PairCompleted = {
      peer_name: peerName,
      peer_host: peerHost,
      peer_port: peerPort,
      peer_outgoing_token: peerToken,         // they sent → we expect this from them
      our_outgoing_token: ourOutgoingToken,   // we generate → they expect this from us
      peer_fingerprint: peerFingerprint,
    };

    // Notify the daemon to persist + hot-load. The handler returns true if it
    // wrote peers.toml and our_outgoing_token is now valid; false on failure.
    let accepted = false;
    try {
      accepted = await new Promise<boolean>((resolve) => {
        const handlers = this.listeners("pair_completed");
        if (handlers.length === 0) {
          // No one listening — treat as failure.
          resolve(false);
          return;
        }
        this.emit("pair_completed", evt, (ok: boolean) => resolve(ok));
      });
    } catch {
      accepted = false;
    }

    if (!accepted) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: "PERSIST_FAILED", message: "Could not write peers.toml" }));
      return;
    }

    // Tell the peer our credentials.
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({
      name: this.config.self,
      port: this.config.port,
      token: ourOutgoingToken,
      fingerprint: this.tls.fingerprintSha256,
    }));
  }

  async stop(): Promise<void> {
    this.wss?.close();
    await new Promise<void>((resolve) => this.httpsServer?.close(() => resolve()));
  }
}

function randomToken(): string {
  return "sk_peer_" + crypto.randomBytes(24).toString("hex");
}
