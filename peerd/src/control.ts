// Unix-socket control server for local integration shims (peer-mcp, peer-cli, ...).
// Line-delimited JSON-RPC-ish protocol per PROTOCOL.md §8.

import * as net from "node:net";
import * as fs from "node:fs";
import * as readline from "node:readline";
import { CallManager, InviteEvent } from "./call_manager.js";
import { CallInbox } from "./call_inbox.js";
import { notify } from "./notify.js";
import type { Config } from "./config.js";
import type { Connection } from "./connection.js";
import type { EndPayload } from "./types.js";

type Reply = { id: number; result: unknown } | { id: number; error: { code: string; message: string } };

interface IncomingInvite {
  call_id: string;
  from: string;
  topic: string;
  caller_label: string;
  context_excerpt?: string;
  received_at: string;
}

export interface ControlServerOptions {
  socketPath: string;
  cm: CallManager;
  /** Optional: needed for list_peers to report online state. */
  config?: Config;
  getConnection?: (peerName: string) => Connection | undefined;
  /** Optional: called when peerd should enter pairing mode for N seconds. Returns the deadline (epoch ms). */
  enterPairingMode?: (seconds: number) => number;
  exitPairingMode?: () => void;
  isPairingMode?: () => boolean;
  /** Optional: write a new peer entry to peers.toml and hot-load. Returns true on success. */
  addPeer?: (entry: {
    name: string;
    host: string;
    port: number;
    outgoing_token: string;
    inbound_token: string;
    fingerprint: string;
  }) => Promise<boolean>;
  /** Optional: returns {fingerprint, port, self} for the `get_self` RPC. */
  getSelfInfo?: () => { name: string; port: number; fingerprint: string };
}

export class ControlServer {
  private socketPath: string;
  private cm: CallManager;
  private inbox: CallInbox;
  private config?: Config;
  private getConnection?: (peerName: string) => Connection | undefined;
  private enterPairingMode?: (seconds: number) => number;
  private exitPairingMode?: () => void;
  private isPairingMode?: () => boolean;
  private addPeer?: ControlServerOptions["addPeer"];
  private getSelfInfo?: ControlServerOptions["getSelfInfo"];
  private server?: net.Server;
  private pendingInvites: Map<string, IncomingInvite> = new Map();
  private inviteSubscribers: Set<(inv: IncomingInvite) => void> = new Set();

  constructor(opts: ControlServerOptions) {
    this.socketPath = opts.socketPath;
    this.cm = opts.cm;
    this.config = opts.config;
    this.getConnection = opts.getConnection;
    this.enterPairingMode = opts.enterPairingMode;
    this.exitPairingMode = opts.exitPairingMode;
    this.isPairingMode = opts.isPairingMode;
    this.addPeer = opts.addPeer;
    this.getSelfInfo = opts.getSelfInfo;
    this.inbox = new CallInbox(this.cm);

    this.cm.on("invite", (inv: InviteEvent) => {
      const stored: IncomingInvite = {
        call_id: inv.call_id,
        from: inv.from,
        topic: inv.topic,
        caller_label: inv.caller_label,
        context_excerpt: inv.context_excerpt,
        received_at: new Date().toISOString(),
      };
      this.pendingInvites.set(inv.call_id, stored);
      for (const cb of this.inviteSubscribers) {
        try { cb(stored); } catch { /* ignore */ }
      }
      notify({
        title: `📞 ${inv.from}@${inv.caller_label}`,
        subtitle: inv.topic,
        message: inv.context_excerpt ?? "Type /accept or /deny in Claude Code.",
      });
    });

    // Once accepted/denied, remove from pending list.
    this.cm.on("connected", ({ call_id }: { call_id: string }) => {
      this.pendingInvites.delete(call_id);
    });
    this.cm.on("ended", ({ call_id }: { call_id: string }) => {
      this.pendingInvites.delete(call_id);
    });
  }

  async start(): Promise<void> {
    try { await fs.promises.unlink(this.socketPath); } catch { /* not present */ }

    this.server = net.createServer((sock) => this.handleClient(sock));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.socketPath, () => {
        this.server!.off("error", reject);
        fs.chmod(this.socketPath, 0o600, () => resolve());
      });
    });
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
    try { await fs.promises.unlink(this.socketPath); } catch { /* ignore */ }
  }

  private handleClient(sock: net.Socket): void {
    const rl = readline.createInterface({ input: sock });
    const subscribed: Array<() => void> = [];

    const writeLine = (obj: unknown) => {
      if (sock.destroyed || !sock.writable) return;
      try {
        sock.write(JSON.stringify(obj) + "\n");
      } catch { /* socket closed */ }
    };

    sock.on("error", () => { /* EPIPE/etc on disconnecting client — fine */ });
    rl.on("error", () => { /* propagated from sock; fine */ });
    sock.on("close", () => {
      for (const off of subscribed) off();
    });

    rl.on("line", async (line) => {
      let req: { id: number; method: string; params?: any };
      try {
        req = JSON.parse(line);
      } catch {
        writeLine({ error: { code: "INVALID_PARAMS", message: "not JSON" } });
        return;
      }
      try {
        const result = await this.dispatch(req.method, req.params ?? {}, {
          writeNotification: (n) => writeLine({ id: req.id, notification: n }),
          onClose: (fn) => subscribed.push(fn),
        });
        writeLine({ id: req.id, result } as Reply);
      } catch (e: any) {
        const code = e?.code ?? "INTERNAL_ERROR";
        const message = e?.message ?? String(e);
        writeLine({ id: req.id, error: { code, message } } as Reply);
      }
    });
  }

  private async dispatch(
    method: string,
    params: Record<string, any>,
    hooks: { writeNotification: (n: unknown) => void; onClose: (fn: () => void) => void },
  ): Promise<unknown> {
    switch (method) {
      case "list_calls":
        return { calls: this.cm.listCalls().map((c) => ({
          call_id: c.call_id,
          state: c.state,
          topic: c.topic,
          caller: c.caller,
          callee: c.callee,
          floor: c.floor,
          remote_peer: c.remotePeerName,
          started_at: c.startedAt,
          ended_at: c.endedAt,
        })) };

      case "list_inbox":
        return { invites: Array.from(this.pendingInvites.values()) };

      case "list_peers": {
        if (!this.config) return { peers: [] };
        const peers = Object.entries(this.config.peers).map(([name, p]) => ({
          name,
          host: p.host,
          port: p.port,
          online: this.getConnection ? Boolean(this.getConnection(name)) : false,
        }));
        return { peers };
      }

      case "subscribe_inbox": {
        // Stream notifications for new invites until the client disconnects.
        for (const inv of this.pendingInvites.values()) {
          hooks.writeNotification({ kind: "invite", payload: inv });
        }
        const cb = (inv: IncomingInvite) => {
          hooks.writeNotification({ kind: "invite", payload: inv });
        };
        this.inviteSubscribers.add(cb);
        hooks.onClose(() => this.inviteSubscribers.delete(cb));
        return { subscribed: true };
      }

      case "invite": {
        const peer = String(params.peer ?? "");
        const topic = String(params.topic ?? "");
        if (!peer || !topic) throw rpcError("INVALID_PARAMS", "peer and topic required");
        const inviteTimeoutMs = params.invite_timeout_s !== undefined
          ? Math.round(Number(params.invite_timeout_s) * 1000)
          : undefined;
        const res = await this.cm.invite(peer, topic, {
          caller_label: params.caller_label as string | undefined,
          context_excerpt: params.context_excerpt as string | undefined,
          first_floor: params.first_floor as "caller" | "callee" | undefined,
          invite_timeout_ms: inviteTimeoutMs,
        });
        return res;
      }

      case "accept_invite": {
        const cid = String(params.call_id ?? "");
        if (!cid) throw rpcError("INVALID_PARAMS", "call_id required");
        return await this.cm.acceptInvite(cid);
      }

      case "deny_invite": {
        const cid = String(params.call_id ?? "");
        if (!cid) throw rpcError("INVALID_PARAMS", "call_id required");
        await this.cm.denyInvite(cid, params.reason ? String(params.reason) : undefined);
        return { ok: true };
      }

      case "send": {
        const cid = String(params.call_id ?? "");
        const text = String(params.text ?? "");
        if (!cid || !text) throw rpcError("INVALID_PARAMS", "call_id and text required");
        return await this.cm.send(cid, text);
      }

      case "recv": {
        const cid = String(params.call_id ?? "");
        const timeoutS = Number(params.timeout_s ?? 60);
        if (!cid) throw rpcError("INVALID_PARAMS", "call_id required");
        const evt = await this.inbox.recv(cid, Math.max(1, timeoutS) * 1000);
        return evt;
      }

      case "human_inject": {
        const cid = String(params.call_id ?? "");
        const tag = String(params.tag ?? "");
        const text = String(params.text ?? "");
        if (!cid || !tag || !text) throw rpcError("INVALID_PARAMS", "call_id/tag/text required");
        return await this.cm.humanInject(cid, tag, text, params.priority);
      }

      case "end": {
        const cid = String(params.call_id ?? "");
        if (!cid) throw rpcError("INVALID_PARAMS", "call_id required");
        return await this.cm.end(cid, {
          reason: params.reason as EndPayload["reason"] | undefined,
          agreement: params.agreement,
          action_items: params.action_items,
        });
      }

      case "status": {
        const cid = params.call_id ? String(params.call_id) : undefined;
        if (cid) {
          const c = this.cm.getCall(cid);
          if (!c) throw rpcError("UNKNOWN_CALL", `unknown call ${cid}`);
          return {
            call_state: c.state,
            floor: c.floor,
            remote_peer: c.remotePeerName,
            started_at: c.startedAt,
            ended_at: c.endedAt,
          };
        }
        return {
          calls: this.cm.listCalls().length,
          pending_invites: this.pendingInvites.size,
        };
      }

      case "enter_pairing_mode": {
        if (!this.enterPairingMode) throw rpcError("NOT_SUPPORTED", "pairing not wired into this peerd");
        const seconds = Math.max(5, Number(params.seconds ?? 60));
        const deadline = this.enterPairingMode(seconds);
        return { ok: true, expires_at: new Date(deadline).toISOString() };
      }

      case "exit_pairing_mode": {
        if (!this.exitPairingMode) throw rpcError("NOT_SUPPORTED", "pairing not wired into this peerd");
        this.exitPairingMode();
        return { ok: true };
      }

      case "is_pairing_mode":
        return { active: this.isPairingMode ? this.isPairingMode() : false };

      case "add_peer": {
        if (!this.addPeer) throw rpcError("NOT_SUPPORTED", "addPeer not wired");
        const ok = await this.addPeer({
          name: String(params.name ?? ""),
          host: String(params.host ?? ""),
          port: Number(params.port ?? 7777),
          outgoing_token: String(params.outgoing_token ?? ""),
          inbound_token: String(params.inbound_token ?? ""),
          fingerprint: String(params.fingerprint ?? ""),
        });
        return { ok };
      }

      case "get_self": {
        if (!this.getSelfInfo) throw rpcError("NOT_SUPPORTED", "getSelfInfo not wired");
        return this.getSelfInfo();
      }

      default:
        throw rpcError("UNKNOWN_METHOD", `no such method: ${method}`);
    }
  }
}

function rpcError(code: string, message: string): Error & { code: string } {
  const e = new Error(message) as Error & { code: string };
  e.code = code;
  return e;
}
