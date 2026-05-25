// Unix-socket control server for local integration shims (peer-mcp, peer-cli, ...).
// Line-delimited JSON-RPC-ish protocol per PROTOCOL.md §8.

import * as net from "node:net";
import * as fs from "node:fs";
import * as crypto from "node:crypto";
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

/** Per-subscription state used for opt-in routing and discovery. */
export interface SubscriberInfo {
  subscriber_id: string;
  /** When this subscription was added (epoch ms). */
  subscribed_at: number;
  /** false (default) = invites are NEVER routed to this subscriber. */
  available: boolean;
  /** Optional human-readable label set via set_session_metadata. */
  label?: string;
  /** Optional cwd of the originating claude session. */
  cwd?: string;
  /** Callback used to deliver invite events; silent=true means no popup. */
  inviteCb: (inv: IncomingInvite, silent: boolean) => void;
  /** Callback for invite_resolved events (so popups dismiss cleanly). */
  resolvedCb: (evt: { call_id: string; resolution: "accepted" | "declined" | "ended" }) => void;
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
  // New: ordered Map of subscriber_id → SubscriberInfo. Insertion order
  // preserved so "newest subscriber wins" + ownership checks remain stable.
  private subscribers: Map<string, SubscriberInfo> = new Map();

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

    this.cm.on("invite", (inv: InviteEvent & { target_subscriber_id?: string }) => {
      const stored: IncomingInvite = {
        call_id: inv.call_id,
        from: inv.from,
        topic: inv.topic,
        caller_label: inv.caller_label,
        context_excerpt: inv.context_excerpt,
        received_at: new Date().toISOString(),
      };
      this.pendingInvites.set(inv.call_id, stored);
      this.dispatchInviteToSubscribers(stored, inv.target_subscriber_id);
      notify({
        title: `📞 ${inv.from}@${inv.caller_label}`,
        subtitle: inv.topic,
        message: inv.context_excerpt ?? "Type /accept or /deny in Claude Code.",
      });
    });

    // Once accepted/denied/ended/timed-out: remove from pending list AND
    // broadcast a resolution notification so every other peer-mcp subscribed
    // can suppress / dismiss any popup it might be about to show.
    this.cm.on("connected", ({ call_id }: { call_id: string }) => {
      if (this.pendingInvites.has(call_id)) {
        this.pendingInvites.delete(call_id);
        this.broadcastInviteResolved(call_id, "accepted");
      }
    });
    this.cm.on("ended", ({ call_id }: { call_id: string }) => {
      if (this.pendingInvites.has(call_id)) {
        this.pendingInvites.delete(call_id);
        this.broadcastInviteResolved(call_id, "ended");
      }
    });
  }

  /**
   * Dispatch an invite to subscribers per the routing rules:
   *   - If target_subscriber_id given: deliver ONLY to that subscriber
   *     (non-silent). Other subscribers get nothing. The targeted subscriber
   *     must currently be available, otherwise the call has already failed
   *     at the wire level and we never reach this code path.
   *   - Otherwise: deliver to all AVAILABLE subscribers. The newest available
   *     gets non-silent (popup); all older available subscribers get silent.
   *     Unavailable subscribers get nothing.
   */
  private dispatchInviteToSubscribers(inv: IncomingInvite, targetSubscriberId?: string): void {
    if (targetSubscriberId) {
      const sub = this.subscribers.get(targetSubscriberId);
      if (sub && sub.available) {
        try { sub.inviteCb(inv, false); } catch { /* ignore */ }
      }
      return;
    }
    const availableSubs: SubscriberInfo[] = [];
    for (const s of this.subscribers.values()) if (s.available) availableSubs.push(s);
    availableSubs.forEach((s, idx) => {
      const isNewest = idx === availableSubs.length - 1;
      try { s.inviteCb(inv, !isNewest); } catch { /* ignore */ }
    });
  }

  /** Snapshot of currently-available subscribers, for list_sessions. */
  listAvailableSessions(): Array<{ id: string; label?: string; cwd?: string; subscribed_at: number }> {
    const out: Array<{ id: string; label?: string; cwd?: string; subscribed_at: number }> = [];
    for (const s of this.subscribers.values()) {
      if (!s.available) continue;
      out.push({ id: s.subscriber_id, label: s.label, cwd: s.cwd, subscribed_at: s.subscribed_at });
    }
    if (process.env.PEERD_DEBUG_SUBS) console.error(`[peerd] listAvailableSessions: ${out.length}/${this.subscribers.size} available`);
    return out;
  }

  /** Lookup subscriber metadata by id; used by CallManager to validate targets. */
  getSubscriber(id: string): SubscriberInfo | undefined {
    return this.subscribers.get(id);
  }

  hasAvailableSubscribers(): boolean {
    for (const s of this.subscribers.values()) if (s.available) return true;
    return false;
  }

  private broadcastInviteResolved(call_id: string, resolution: "accepted" | "declined" | "ended"): void {
    for (const sub of this.subscribers.values()) {
      try { sub.resolvedCb({ call_id, resolution }); } catch { /* ignore */ }
    }
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
        // Register this connection as a subscriber. Default: available=false.
        // The peer-mcp must call set_session_metadata({ available: true, ... })
        // to become routable. Until then, no invites are routed to it.
        const subscriber_id = "s_" + crypto.randomBytes(8).toString("hex");
        const subscribed_at = Date.now();

        const inviteCb = (inv: IncomingInvite, silent: boolean) => {
          hooks.writeNotification({ kind: "invite", payload: inv, silent });
        };
        const resolvedCb = (evt: { call_id: string; resolution: "accepted" | "declined" | "ended" }) => {
          hooks.writeNotification({ kind: "invite_resolved", payload: evt });
        };

        const info: SubscriberInfo = {
          subscriber_id,
          subscribed_at,
          available: false,
          inviteCb,
          resolvedCb,
        };
        this.subscribers.set(subscriber_id, info);

        // First notification a subscriber receives is its own ID so it can
        // pass that back via set_session_metadata. Then any replayed pending
        // invites (only non-silently if this subscription is available — which
        // it isn't yet at this point, so they're skipped). The subscriber will
        // typically call set_session_metadata immediately after subscribing.
        hooks.writeNotification({ kind: "subscribed", payload: { subscriber_id } });

        hooks.onClose(() => {
          this.subscribers.delete(subscriber_id);
          // If a pending invite was waiting for the popup on this (just-left)
          // subscriber, dispatch it to any remaining available subscribers.
          if (this.pendingInvites.size > 0 && this.hasAvailableSubscribers()) {
            for (const inv of this.pendingInvites.values()) {
              this.dispatchInviteToSubscribers(inv);
            }
          }
        });
        return { subscribed: true, subscriber_id };
      }

      case "set_session_metadata": {
        const id = String(params.subscriber_id ?? "");
        if (!id) throw rpcError("INVALID_PARAMS", "subscriber_id required");
        const sub = this.subscribers.get(id);
        if (!sub) throw rpcError("UNKNOWN_SUBSCRIBER", `no subscriber ${id}; have ${Array.from(this.subscribers.keys()).join(",")}`);
        const wasAvailable = sub.available;
        if (typeof params.available === "boolean") sub.available = params.available;
        if (params.label !== undefined) sub.label = params.label ? String(params.label) : undefined;
        if (params.cwd !== undefined) sub.cwd = params.cwd ? String(params.cwd) : undefined;
        if (process.env.PEERD_DEBUG_SUBS) console.error(`[peerd] set_session_metadata id=${id} available=${sub.available} label=${sub.label} cwd=${sub.cwd}`);
        // If we just BECAME available and there are pending invites, replay them
        // so the new available subscriber sees the popup.
        if (!wasAvailable && sub.available && this.pendingInvites.size > 0) {
          for (const inv of this.pendingInvites.values()) {
            try { sub.inviteCb(inv, false); } catch { /* ignore */ }
          }
        }
        return { ok: true, subscriber_id: id, available: sub.available, label: sub.label, cwd: sub.cwd };
      }

      case "list_local_sessions":
        return { sessions: this.listAvailableSessions() };

      case "list_remote_sessions": {
        const peer = String(params.peer ?? "");
        if (!peer) throw rpcError("INVALID_PARAMS", "peer required");
        const conn = this.getConnection ? this.getConnection(peer) : undefined;
        if (!conn) throw rpcError("PEER_UNREACHABLE", `no live connection to peer "${peer}"`);
        const sessions = await this.cm.listRemoteSessions(peer, 5000);
        return { sessions };
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
          target_subscriber_id: params.target_session_id as string | undefined,
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

      case "share_file": {
        const cid = String(params.call_id ?? "");
        const filePath = String(params.path ?? "");
        const content = String(params.content ?? "");
        if (!cid || !filePath) throw rpcError("INVALID_PARAMS", "call_id and path required");
        return await this.cm.shareFile(cid, {
          path: filePath,
          content,
          language: params.language as string | undefined,
          reason: params.reason as string | undefined,
        });
      }

      case "propose_change": {
        const cid = String(params.call_id ?? "");
        const target_file = String(params.target_file ?? "");
        const diff = String(params.diff ?? "");
        const rationale = String(params.rationale ?? "");
        if (!cid || !target_file || !diff || !rationale) {
          throw rpcError("INVALID_PARAMS", "call_id, target_file, diff, rationale all required");
        }
        return await this.cm.proposeChange(cid, {
          target_file,
          diff,
          rationale,
          requires_human_approval: params.requires_human_approval as boolean | undefined,
          tests_added: params.tests_added as Array<{ path: string; diff: string }> | undefined,
        });
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
