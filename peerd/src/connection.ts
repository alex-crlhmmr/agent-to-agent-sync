import { EventEmitter } from "node:events";
import type WebSocket from "ws";
import {
  Envelope,
  ErrorCode,
  HelloPayload,
  M1_CAPABILITIES,
  PEER_VERSION,
  PROTOCOL_VERSION,
  PingPayload,
  PongPayload,
  WelcomePayload,
} from "./types.js";
import { decode, encode, envelope, errorEnvelope, WireError } from "./wire.js";
import { nowIso, randomNonce } from "./ids.js";

const HANDSHAKE_TIMEOUT_MS = 5000;
const HEARTBEAT_INTERVAL_MS = 15_000;
const HEARTBEAT_IDLE_TIMEOUT_MS = 60_000;

export type Role = "server" | "client";

export interface ConnectionOptions {
  ws: WebSocket;
  role: Role;
  selfName: string;
  advertisedName?: string;
  expectedPeerName?: string;  // server: from upgrade headers; client: from peers.toml
  capabilities?: string[];
}

export class Connection extends EventEmitter {
  private ws: WebSocket;
  private role: Role;
  private selfName: string;
  private advertisedName: string;
  private expectedPeerName?: string;
  private localCaps: string[];
  private handshakeTimer?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;
  private lastInboundAt: number = Date.now();
  private ready = false;
  private closed = false;
  peerName: string = "";
  agreedCapabilities: string[] = [];

  constructor(opts: ConnectionOptions) {
    super();
    this.ws = opts.ws;
    this.role = opts.role;
    this.selfName = opts.selfName;
    this.advertisedName = opts.advertisedName ?? opts.selfName;
    this.expectedPeerName = opts.expectedPeerName;
    this.localCaps = opts.capabilities ?? M1_CAPABILITIES;

    this.ws.on("message", (data: Buffer) => this.handleRaw(data.toString("utf8")));
    this.ws.on("close", (code: number, reason: Buffer) => {
      this.cleanup();
      this.emit("close", reason.toString("utf8") || `code=${code}`);
    });
    this.ws.on("error", (err: Error) => {
      this.emit("error", err);
    });

    this.handshakeTimer = setTimeout(() => {
      if (!this.ready) {
        this.close(1008, "handshake timeout");
      }
    }, HANDSHAKE_TIMEOUT_MS);

    if (this.role === "client") {
      // Client speaks first.
      this.sendHello();
    }
  }

  private sendHello(): void {
    const payload: HelloPayload = {
      peer_version: PEER_VERSION,
      capabilities: this.localCaps,
      advertised_name: this.advertisedName,
      supported_protocol_versions: [PROTOCOL_VERSION],
    };
    this.sendRaw(envelope("HELLO", this.selfName, payload));
  }

  private sendWelcome(remoteHello: HelloPayload): void {
    if (!remoteHello.supported_protocol_versions?.includes(PROTOCOL_VERSION)) {
      this.fatal(ErrorCode.UNSUPPORTED_VERSION, "no common protocol version");
      return;
    }
    const remoteCaps = new Set(remoteHello.capabilities ?? []);
    this.agreedCapabilities = this.localCaps.filter((c) => remoteCaps.has(c));
    const payload: WelcomePayload = {
      peer_version: PEER_VERSION,
      capabilities: this.localCaps,
      protocol_version: PROTOCOL_VERSION,
      server_time: nowIso(),
    };
    this.sendRaw(envelope("WELCOME", this.selfName, payload));
    this.finishHandshake();
  }

  private handleRaw(raw: string): void {
    this.lastInboundAt = Date.now();
    let env: Envelope;
    try {
      env = decode(raw);
    } catch (e: any) {
      if (e instanceof WireError) {
        this.sendRaw(errorEnvelope(this.selfName, e.code, e.message));
      }
      return;
    }

    // Verify "from" matches what we expected (when known)
    if (this.expectedPeerName && env.from !== this.expectedPeerName && env.type !== "HELLO") {
      this.fatal(ErrorCode.UNKNOWN_PEER, `expected from=${this.expectedPeerName} got ${env.from}`);
      return;
    }

    switch (env.type) {
      case "HELLO":
        if (this.role !== "server" || this.ready) {
          this.fatal(ErrorCode.INVALID_MESSAGE, "unexpected HELLO");
          return;
        }
        if (this.expectedPeerName && env.from !== this.expectedPeerName) {
          this.fatal(ErrorCode.UNKNOWN_PEER, `expected from=${this.expectedPeerName} got ${env.from}`);
          return;
        }
        this.peerName = env.from;
        this.sendWelcome(env.payload as HelloPayload);
        return;

      case "WELCOME":
        if (this.role !== "client" || this.ready) {
          this.fatal(ErrorCode.INVALID_MESSAGE, "unexpected WELCOME");
          return;
        }
        {
          const w = env.payload as WelcomePayload;
          if (w.protocol_version !== PROTOCOL_VERSION) {
            this.fatal(ErrorCode.UNSUPPORTED_VERSION, `server picked v=${w.protocol_version}`);
            return;
          }
          const remoteCaps = new Set(w.capabilities ?? []);
          this.agreedCapabilities = this.localCaps.filter((c) => remoteCaps.has(c));
          this.peerName = env.from;
          this.finishHandshake();
        }
        return;

      case "PING": {
        const p = env.payload as PingPayload;
        const pong: PongPayload = { nonce: p.nonce };
        this.sendRaw(envelope("PONG", this.selfName, pong));
        return;
      }

      case "PONG":
        // heartbeat satisfied; nothing else to do
        return;

      case "DISCONNECT":
        this.close(1000, "peer disconnect");
        return;

      default:
        if (!this.ready) {
          this.fatal(ErrorCode.INVALID_MESSAGE, `message before handshake: ${env.type}`);
          return;
        }
        this.emit("message", env);
    }
  }

  private finishHandshake(): void {
    if (this.ready) return;
    this.ready = true;
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.handshakeTimer = undefined;
    this.startHeartbeat();
    this.emit("ready", { peerName: this.peerName, agreedCapabilities: this.agreedCapabilities });
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      const idle = Date.now() - this.lastInboundAt;
      if (idle > HEARTBEAT_IDLE_TIMEOUT_MS) {
        this.close(1001, "idle timeout");
        return;
      }
      this.sendRaw(envelope<PingPayload>("PING", this.selfName, { nonce: randomNonce() }));
    }, HEARTBEAT_INTERVAL_MS);
  }

  send<T>(env: Envelope<T>): void {
    if (!this.ready) throw new Error("connection not ready");
    this.sendRaw(env);
  }

  private sendRaw<T>(env: Envelope<T>): void {
    if (this.closed) return;
    try {
      this.ws.send(encode(env));
    } catch (e) {
      this.emit("error", e);
    }
  }

  private fatal(code: string, message: string): void {
    this.sendRaw(errorEnvelope(this.selfName, code, message));
    this.close(1008, `${code}: ${message}`);
  }

  close(code = 1000, reason = ""): void {
    if (this.closed) return;
    this.closed = true;
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    try {
      this.ws.close(code, reason);
    } catch {
      /* ignore */
    }
  }

  private cleanup(): void {
    this.closed = true;
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
  }
}
