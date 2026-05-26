import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Connection } from "./connection.js";
import {
  CallRecord,
  EndPayload,
  Envelope,
  ErrorCode,
  HumanInjectPayload,
  InvitePayload,
  InviteResponsePayload,
  ListSessionsPayload,
  ListSessionsResponsePayload,
  ProposeChangePayload,
  SendPayload,
  SessionInfo,
  ShareFilePayload,
  SHARE_FILE_MAX_BYTES,
} from "./types.js";
import { callId, nowIso, sessionToken } from "./ids.js";
import { envelope, errorEnvelope } from "./wire.js";
import * as crypto from "node:crypto";

const INVITE_TIMEOUT_MS_DEFAULT = 150_000; // 2.5 minutes — overridable per call via invite opts

export interface LocalSubscriberSnapshot {
  id: string;
  label?: string;
  cwd?: string;
  subscribed_at: number;
}

export interface CallManagerOptions {
  selfName: string;
  stateDir: string;
  /** Look up the active Connection to a peer by peer name. */
  getConnection: (peerName: string) => Connection | undefined;
  /** Optional: snapshot of locally-available subscribers (only set after ControlServer is wired). */
  listLocalAvailable?: () => LocalSubscriberSnapshot[];
  /** Optional: is this local subscriber ID currently available? */
  isLocalSubscriberAvailable?: (id: string) => boolean;
}

interface PendingInvite {
  resolve: (info: InviteResolution) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export interface InviteResolution {
  call_id: string;
  accepted: boolean;
  reason?: string;
  session_token?: string;
}

export interface InviteEvent {
  call_id: string;
  from: string;
  topic: string;
  caller_label: string;
  context_excerpt?: string;
  /** If set by remote caller, route popup ONLY to this subscriber. */
  target_subscriber_id?: string;
}

export interface CallMessageEvent {
  call_id: string;
  kind: "send" | "end" | "human_inject" | "file_shared" | "change_proposed";
  seq: number;
  from: string;
  payload: SendPayload | EndPayload | HumanInjectPayload | ShareFilePayload | ProposeChangePayload;
}

/** In-flight LIST_SESSIONS request awaiting a response from a peer. */
interface PendingListSessions {
  resolve: (sessions: SessionInfo[]) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class CallManager extends EventEmitter {
  private selfName: string;
  private stateDir: string;
  private getConnection: (peerName: string) => Connection | undefined;
  private listLocalAvailable?: () => LocalSubscriberSnapshot[];
  private isLocalSubscriberAvailable?: (id: string) => boolean;
  private calls: Map<string, CallRecord> = new Map();
  private pending: Map<string, PendingInvite> = new Map();
  private pendingListSessions: Map<string, PendingListSessions> = new Map();

  constructor(opts: CallManagerOptions) {
    super();
    this.selfName = opts.selfName;
    this.stateDir = opts.stateDir;
    this.getConnection = opts.getConnection;
    this.listLocalAvailable = opts.listLocalAvailable;
    this.isLocalSubscriberAvailable = opts.isLocalSubscriberAvailable;
  }

  /** Inject the ControlServer-backed helpers post-construction (resolves circular dep). */
  setSubscriberAccessors(opts: {
    listLocalAvailable: () => LocalSubscriberSnapshot[];
    isLocalSubscriberAvailable: (id: string) => boolean;
  }): void {
    this.listLocalAvailable = opts.listLocalAvailable;
    this.isLocalSubscriberAvailable = opts.isLocalSubscriberAvailable;
  }

  attachConnection(conn: Connection): void {
    conn.on("message", (env: Envelope) => this.routeIncoming(conn, env));
  }

  getCall(callIdStr: string): CallRecord | undefined {
    return this.calls.get(callIdStr);
  }

  listCalls(): CallRecord[] {
    return Array.from(this.calls.values());
  }

  // ──────────────────────────── outgoing API ────────────────────────────

  async invite(peerName: string, topic: string, opts: { caller_label?: string; context_excerpt?: string; first_floor?: "caller" | "callee"; invite_timeout_ms?: number; target_subscriber_id?: string } = {}): Promise<InviteResolution> {
    const inviteTimeoutMs = Math.max(5_000, Math.min(600_000, opts.invite_timeout_ms ?? INVITE_TIMEOUT_MS_DEFAULT));
    const conn = this.getConnection(peerName);
    if (!conn) throw new Error(`peer "${peerName}" not connected`);

    const cid = callId();
    const transcriptDir = path.join(this.stateDir, "calls", cid);
    await fs.promises.mkdir(transcriptDir, { recursive: true });

    const call: CallRecord = {
      call_id: cid,
      state: "DIALING",
      topic,
      caller: this.selfName,
      callee: peerName,
      isLocalCaller: true,
      floor: opts.first_floor ?? "caller",
      seqOut: 0,
      seqIn: 0,
      sessionToken: undefined,
      startedAt: nowIso(),
      capabilities: conn.agreedCapabilities,
      transcriptPath: path.join(transcriptDir, "transcript.jsonl"),
      remotePeerName: peerName,
    };
    this.calls.set(cid, call);
    await this.persistMeta(call);

    const payload: InvitePayload = {
      topic,
      caller_label: opts.caller_label ?? this.selfName,
      first_floor: opts.first_floor ?? "caller",
      context_excerpt: opts.context_excerpt,
      expires_at: new Date(Date.now() + inviteTimeoutMs).toISOString(),
      target_subscriber_id: opts.target_subscriber_id,
    };

    const env = envelope<InvitePayload>("INVITE", this.selfName, payload, {
      call_id: cid,
      seq: ++call.seqOut,
    });
    await this.appendTranscript(call, "out", env);
    conn.send(env);

    return new Promise<InviteResolution>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(cid);
        const c = this.calls.get(cid);
        if (c && c.state === "DIALING") {
          c.state = "CLOSED";
          c.endedAt = nowIso();
          this.persistMeta(c).catch(() => {});
          // Notify callee so its RINGING entry isn't left orphaned.
          const peerConn = this.getConnection(c.remotePeerName);
          if (peerConn) {
            const endEnv = envelope<EndPayload>("END", this.selfName, {
              reason: "timeout",
            }, { call_id: cid, seq: ++c.seqOut });
            try { peerConn.send(endEnv); } catch { /* socket may be gone */ }
          }
        }
        resolve({ call_id: cid, accepted: false, reason: "INVITE_TIMEOUT" });
      }, inviteTimeoutMs);
      this.pending.set(cid, { resolve, reject, timer });
    });
  }

  async acceptInvite(call_id: string): Promise<{ session_token: string }> {
    const call = this.expectRingingCall(call_id);
    const token = sessionToken();
    call.sessionToken = token;
    call.state = "CONNECTED";

    const conn = this.getConnection(call.remotePeerName);
    if (!conn) throw new Error(`peer "${call.remotePeerName}" not connected`);

    const env = envelope<InviteResponsePayload>("INVITE_RESPONSE", this.selfName, {
      accepted: true,
      session_token: token,
    }, { call_id, seq: ++call.seqOut });
    await this.appendTranscript(call, "out", env);
    conn.send(env);
    await this.persistMeta(call);
    this.emit("connected", { call_id });
    return { session_token: token };
  }

  async denyInvite(call_id: string, reason?: string): Promise<void> {
    const call = this.expectRingingCall(call_id);
    call.state = "CLOSED";
    call.endedAt = nowIso();
    const conn = this.getConnection(call.remotePeerName);
    if (conn) {
      const env = envelope<InviteResponsePayload>("INVITE_RESPONSE", this.selfName, {
        accepted: false,
        reason,
      }, { call_id, seq: ++call.seqOut });
      await this.appendTranscript(call, "out", env);
      conn.send(env);
    }
    await this.persistMeta(call);
  }

  async send(call_id: string, text: string): Promise<{ seq: number }> {
    const call = this.expectConnectedCall(call_id);
    const myFloor = call.isLocalCaller ? "caller" : "callee";
    if (call.floor !== myFloor) {
      throw new Error("OUT_OF_TURN");
    }
    const env = envelope<SendPayload>("SEND", this.selfName, { text }, {
      call_id,
      seq: ++call.seqOut,
    });
    await this.appendTranscript(call, "out", env);
    const conn = this.getConnection(call.remotePeerName);
    if (!conn) throw new Error(`peer "${call.remotePeerName}" not connected`);
    conn.send(env);
    call.floor = call.isLocalCaller ? "callee" : "caller";
    await this.persistMeta(call);
    return { seq: call.seqOut };
  }

  /**
   * Send an inline file (small files only — hard cap 256 KiB).
   * Same turn-lock rules as send(): must be your turn; transfers floor to peer.
   */
  async shareFile(call_id: string, opts: { path: string; content: string; language?: string; reason?: string }): Promise<{ seq: number; hash_sha256: string }> {
    const call = this.expectConnectedCall(call_id);
    const myFloor = call.isLocalCaller ? "caller" : "callee";
    if (call.floor !== myFloor) throw new Error("OUT_OF_TURN");

    const bytes = Buffer.byteLength(opts.content, "utf8");
    if (bytes > SHARE_FILE_MAX_BYTES) {
      throw new Error(`INLINE_TOO_LARGE: ${bytes} > ${SHARE_FILE_MAX_BYTES} bytes. Use share_file_ref (not yet implemented) for larger files.`);
    }
    const hash_sha256 = crypto.createHash("sha256").update(opts.content).digest("hex");
    const payload: ShareFilePayload = {
      path: opts.path,
      content: opts.content,
      language: opts.language,
      reason: opts.reason,
      hash_sha256,
    };
    const env = envelope<ShareFilePayload>("SHARE_FILE", this.selfName, payload, {
      call_id,
      seq: ++call.seqOut,
    });
    await this.appendTranscript(call, "out", env);
    const conn = this.getConnection(call.remotePeerName);
    if (!conn) throw new Error(`peer "${call.remotePeerName}" not connected`);
    conn.send(env);
    call.floor = call.isLocalCaller ? "callee" : "caller";
    await this.persistMeta(call);
    return { seq: call.seqOut, hash_sha256 };
  }

  /**
   * Propose a change to the peer's local code. The diff is data — peerd does
   * NOT apply it. The receiver's agent decides whether to call its own Edit
   * tool, gated by Claude Code's normal permission flow.
   * Turn-lock rules same as send().
   */
  async proposeChange(call_id: string, opts: { target_file: string; diff: string; rationale: string; requires_human_approval?: boolean; tests_added?: Array<{ path: string; diff: string }> }): Promise<{ seq: number }> {
    const call = this.expectConnectedCall(call_id);
    const myFloor = call.isLocalCaller ? "caller" : "callee";
    if (call.floor !== myFloor) throw new Error("OUT_OF_TURN");

    const payload: ProposeChangePayload = {
      target_file: opts.target_file,
      diff: opts.diff,
      rationale: opts.rationale,
      requires_human_approval: opts.requires_human_approval ?? true,
      tests_added: opts.tests_added,
    };
    const env = envelope<ProposeChangePayload>("PROPOSE_CHANGE", this.selfName, payload, {
      call_id,
      seq: ++call.seqOut,
    });
    await this.appendTranscript(call, "out", env);
    const conn = this.getConnection(call.remotePeerName);
    if (!conn) throw new Error(`peer "${call.remotePeerName}" not connected`);
    conn.send(env);
    call.floor = call.isLocalCaller ? "callee" : "caller";
    await this.persistMeta(call);
    return { seq: call.seqOut };
  }

  async humanInject(call_id: string, tag: string, text: string, priority?: "override" | "advisory"): Promise<{ seq: number }> {
    const call = this.expectActiveCall(call_id);
    const env = envelope<HumanInjectPayload>("HUMAN_INJECT", this.selfName, { tag, text, priority }, {
      call_id,
      seq: ++call.seqOut,
    });
    await this.appendTranscript(call, "out", env);
    const conn = this.getConnection(call.remotePeerName);
    if (!conn) throw new Error(`peer "${call.remotePeerName}" not connected`);
    conn.send(env);
    return { seq: call.seqOut };
  }

  async end(call_id: string, opts: { reason?: EndPayload["reason"]; agreement?: EndPayload["agreement"]; action_items?: EndPayload["action_items"] } = {}): Promise<{ artifacts: EndPayload["artifacts"] }> {
    const call = this.expectActiveCall(call_id);
    call.state = "CLOSING";
    const artifacts: EndPayload["artifacts"] = [];
    if (opts.agreement) {
      const p = await this.writeAgreement(call, opts.agreement);
      artifacts.push({ kind: "agreement", path: p });
    }
    if (opts.action_items?.length) {
      const p = await this.writeActionItems(call, opts.action_items);
      artifacts.push({ kind: "action_items", path: p });
    }
    const payload: EndPayload = {
      reason: opts.reason ?? "agreement_reached",
      agreement: opts.agreement,
      action_items: opts.action_items,
      artifacts,
    };
    const env = envelope<EndPayload>("END", this.selfName, payload, {
      call_id,
      seq: ++call.seqOut,
    });
    await this.appendTranscript(call, "out", env);
    const conn = this.getConnection(call.remotePeerName);
    if (conn) conn.send(env);
    call.state = "CLOSED";
    call.endedAt = nowIso();
    await this.persistMeta(call);
    this.emit("ended", { call_id, by: "local", artifacts });
    return { artifacts };
  }

  // ──────────────────────────── incoming routing ────────────────────────────

  private async routeIncoming(conn: Connection, env: Envelope): Promise<void> {
    const cid = env.call_id;

    switch (env.type) {
      case "INVITE":
        await this.handleIncomingInvite(conn, env);
        return;

      case "INVITE_RESPONSE":
        if (!cid) return;
        await this.handleInviteResponse(cid, env);
        return;

      case "SEND":
        if (!cid) return;
        await this.handleIncomingSend(conn, cid, env);
        return;

      case "SHARE_FILE":
        if (!cid) return;
        await this.handleIncomingShareFile(conn, cid, env);
        return;

      case "PROPOSE_CHANGE":
        if (!cid) return;
        await this.handleIncomingProposeChange(conn, cid, env);
        return;

      case "HUMAN_INJECT":
        if (!cid) return;
        await this.handleIncomingHumanInject(cid, env);
        return;

      case "END":
        if (!cid) return;
        await this.handleIncomingEnd(cid, env);
        return;

      case "ERROR":
        // For now, just log; later we may use this for invite rejection paths etc.
        this.emit("peer_error", { call_id: cid, ...(env.payload as object) });
        return;

      case "LIST_SESSIONS": {
        const p = env.payload as ListSessionsPayload;
        const available = this.listLocalAvailable?.() ?? [];
        if (process.env.PEERD_DEBUG_SUBS) console.log(`[cm] LIST_SESSIONS inbound; have ${available.length} available`);
        const respPayload: ListSessionsResponsePayload = {
          request_id: p.request_id,
          sessions: available.map((s) => ({
            id: s.id,
            label: s.label,
            cwd: s.cwd,
            subscribed_at: new Date(s.subscribed_at).toISOString(),
          })),
        };
        const respEnv = envelope<ListSessionsResponsePayload>("LIST_SESSIONS_RESPONSE", this.selfName, respPayload);
        try { conn.send(respEnv); } catch { /* ignore */ }
        return;
      }

      case "LIST_SESSIONS_RESPONSE": {
        const p = env.payload as ListSessionsResponsePayload;
        if (process.env.PEERD_DEBUG_SUBS) console.log(`[cm] LIST_SESSIONS_RESPONSE for request ${p.request_id}: ${p.sessions.length} sessions`);
        const pending = this.pendingListSessions.get(p.request_id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingListSessions.delete(p.request_id);
          pending.resolve(p.sessions);
        }
        return;
      }

      default:
        return;
    }
  }

  /** Send LIST_SESSIONS to a peer and await its response (up to timeoutMs). */
  async listRemoteSessions(peerName: string, timeoutMs: number = 5000): Promise<SessionInfo[]> {
    const conn = this.getConnection(peerName);
    if (!conn) throw new Error(`peer "${peerName}" not connected`);
    const request_id = "lr_" + crypto.randomBytes(8).toString("hex");
    const env = envelope<ListSessionsPayload>("LIST_SESSIONS", this.selfName, { request_id });
    if (process.env.PEERD_DEBUG_SUBS) console.log(`[cm] listRemoteSessions: sending LIST_SESSIONS request_id=${request_id} to ${peerName}`);
    return new Promise<SessionInfo[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingListSessions.delete(request_id);
        reject(new Error("list_remote_sessions timeout"));
      }, timeoutMs);
      this.pendingListSessions.set(request_id, { resolve, reject, timer });
      try { conn.send(env); } catch (e) {
        clearTimeout(timer);
        this.pendingListSessions.delete(request_id);
        reject(e as Error);
      }
    });
  }

  private async handleIncomingInvite(conn: Connection, env: Envelope): Promise<void> {
    const cid = env.call_id;
    const p = env.payload as InvitePayload;
    if (!cid) {
      conn.send(errorEnvelope(this.selfName, ErrorCode.INVALID_MESSAGE, "INVITE missing call_id"));
      return;
    }
    if (this.calls.has(cid)) {
      conn.send(errorEnvelope(this.selfName, ErrorCode.INVALID_MESSAGE, "duplicate call_id", { call_id: cid }));
      return;
    }

    // Opt-in gate. Before we even materialize a RINGING call, reject if no
    // available session can take it.
    if (p.target_subscriber_id) {
      const ok = this.isLocalSubscriberAvailable?.(p.target_subscriber_id) ?? false;
      if (!ok) {
        await this.appendStandaloneTranscript(cid, env);
        const respEnv = envelope<InviteResponsePayload>("INVITE_RESPONSE", this.selfName, {
          accepted: false,
          reason: ErrorCode.NO_SUCH_SESSION,
        }, { call_id: cid });
        try { conn.send(respEnv); } catch { /* ignore */ }
        return;
      }
    } else {
      const available = this.listLocalAvailable?.() ?? [];
      if (available.length === 0) {
        await this.appendStandaloneTranscript(cid, env);
        const respEnv = envelope<InviteResponsePayload>("INVITE_RESPONSE", this.selfName, {
          accepted: false,
          reason: ErrorCode.NO_AVAILABLE_SESSIONS,
        }, { call_id: cid });
        try { conn.send(respEnv); } catch { /* ignore */ }
        return;
      }
    }

    const transcriptDir = path.join(this.stateDir, "calls", cid);
    await fs.promises.mkdir(transcriptDir, { recursive: true });
    const call: CallRecord = {
      call_id: cid,
      state: "RINGING",
      topic: p.topic,
      caller: env.from,
      callee: this.selfName,
      isLocalCaller: false,
      floor: p.first_floor ?? "caller",
      seqOut: 0,
      seqIn: env.seq ?? 0,
      startedAt: nowIso(),
      capabilities: conn.agreedCapabilities,
      transcriptPath: path.join(transcriptDir, "transcript.jsonl"),
      remotePeerName: env.from,
    };
    this.calls.set(cid, call);
    await this.appendTranscript(call, "in", env);
    await this.persistMeta(call);
    const evt: InviteEvent = {
      call_id: cid,
      from: env.from,
      topic: p.topic,
      caller_label: p.caller_label,
      context_excerpt: p.context_excerpt,
      target_subscriber_id: p.target_subscriber_id,
    };
    this.emit("invite", evt);
  }

  /** For fast-reject paths where we don't materialize a CallRecord. Logs the inbound INVITE
   *  to a one-off transcript so the rejection is auditable. */
  private async appendStandaloneTranscript(cid: string, env: Envelope): Promise<void> {
    const dir = path.join(this.stateDir, "calls", cid);
    try {
      await fs.promises.mkdir(dir, { recursive: true });
      const line = JSON.stringify({ dir: "in_rejected", recorded_at: nowIso(), env }) + "\n";
      await fs.promises.appendFile(path.join(dir, "transcript.jsonl"), line);
    } catch { /* best-effort */ }
  }

  private async handleInviteResponse(cid: string, env: Envelope): Promise<void> {
    const call = this.calls.get(cid);
    if (!call) return;
    const p = env.payload as InviteResponsePayload;
    await this.appendTranscript(call, "in", env);

    // Race fix: if we already timed out and closed this call, the caller's promise
    // resolved with INVITE_TIMEOUT and we sent the peer an END. Don't reopen the call
    // even though the peer's accept landed afterwards — tell them it's closed.
    if (call.state === "CLOSED") {
      const peerConn = this.getConnection(call.remotePeerName);
      if (peerConn && p.accepted) {
        const endEnv = envelope<EndPayload>("END", this.selfName, {
          reason: "timeout",
        }, { call_id: cid, seq: ++call.seqOut });
        try { peerConn.send(endEnv); } catch { /* socket may be gone */ }
      }
      return;
    }

    const pending = this.pending.get(cid);
    if (pending) {
      clearTimeout(pending.timer);
      this.pending.delete(cid);
      pending.resolve({ call_id: cid, accepted: p.accepted, reason: p.reason, session_token: p.session_token });
    }
    if (p.accepted) {
      call.state = "CONNECTED";
      call.sessionToken = p.session_token;
    } else {
      call.state = "CLOSED";
      call.endedAt = nowIso();
    }
    await this.persistMeta(call);
  }

  private async handleIncomingSend(conn: Connection, cid: string, env: Envelope): Promise<void> {
    const call = this.calls.get(cid);
    if (!call || call.state !== "CONNECTED") {
      conn.send(errorEnvelope(this.selfName, ErrorCode.UNKNOWN_CALL, "no such connected call", { call_id: cid }));
      return;
    }
    const senderRole = env.from === call.caller ? "caller" : "callee";
    if (call.floor !== senderRole) {
      conn.send(errorEnvelope(this.selfName, ErrorCode.OUT_OF_TURN, "floor mismatch", { call_id: cid, in_response_to_seq: env.seq }));
      return;
    }
    await this.appendTranscript(call, "in", env);
    call.floor = senderRole === "caller" ? "callee" : "caller";
    call.seqIn = env.seq ?? call.seqIn;
    await this.persistMeta(call);
    const evt: CallMessageEvent = {
      call_id: cid,
      kind: "send",
      seq: env.seq ?? 0,
      from: env.from,
      payload: env.payload as SendPayload,
    };
    this.emit("message", evt);
  }

  private async handleIncomingShareFile(conn: Connection, cid: string, env: Envelope): Promise<void> {
    console.log(`[cm] inbound SHARE_FILE call=${cid} from=${env.from} seq=${env.seq}`);
    const call = this.calls.get(cid);
    if (!call) {
      console.log(`[cm] SHARE_FILE: unknown call ${cid}; have calls=[${Array.from(this.calls.keys()).join(",")}]`);
      conn.send(errorEnvelope(this.selfName, ErrorCode.UNKNOWN_CALL, "no such call", { call_id: cid }));
      return;
    }
    if (call.state !== "CONNECTED") {
      console.log(`[cm] SHARE_FILE: call ${cid} not CONNECTED (state=${call.state})`);
      conn.send(errorEnvelope(this.selfName, ErrorCode.UNKNOWN_CALL, `call in state ${call.state}`, { call_id: cid }));
      return;
    }
    const senderRole = env.from === call.caller ? "caller" : "callee";
    if (call.floor !== senderRole) {
      console.log(`[cm] SHARE_FILE: OUT_OF_TURN (floor=${call.floor}, sender=${senderRole})`);
      conn.send(errorEnvelope(this.selfName, ErrorCode.OUT_OF_TURN, "floor mismatch", { call_id: cid, in_response_to_seq: env.seq }));
      return;
    }
    await this.appendTranscript(call, "in", env);
    call.floor = senderRole === "caller" ? "callee" : "caller";
    call.seqIn = env.seq ?? call.seqIn;
    await this.persistMeta(call);
    const evt: CallMessageEvent = {
      call_id: cid,
      kind: "file_shared",
      seq: env.seq ?? 0,
      from: env.from,
      payload: env.payload as ShareFilePayload,
    };
    console.log(`[cm] emitting file_shared message event for call ${cid}`);
    this.emit("message", evt);
  }

  private async handleIncomingProposeChange(conn: Connection, cid: string, env: Envelope): Promise<void> {
    const call = this.calls.get(cid);
    if (!call || call.state !== "CONNECTED") {
      conn.send(errorEnvelope(this.selfName, ErrorCode.UNKNOWN_CALL, "no such connected call", { call_id: cid }));
      return;
    }
    const senderRole = env.from === call.caller ? "caller" : "callee";
    if (call.floor !== senderRole) {
      conn.send(errorEnvelope(this.selfName, ErrorCode.OUT_OF_TURN, "floor mismatch", { call_id: cid, in_response_to_seq: env.seq }));
      return;
    }
    await this.appendTranscript(call, "in", env);
    call.floor = senderRole === "caller" ? "callee" : "caller";
    call.seqIn = env.seq ?? call.seqIn;
    await this.persistMeta(call);
    const evt: CallMessageEvent = {
      call_id: cid,
      kind: "change_proposed",
      seq: env.seq ?? 0,
      from: env.from,
      payload: env.payload as ProposeChangePayload,
    };
    this.emit("message", evt);
  }

  private async handleIncomingHumanInject(cid: string, env: Envelope): Promise<void> {
    const call = this.calls.get(cid);
    if (!call) return;
    await this.appendTranscript(call, "in", env);
    const evt: CallMessageEvent = {
      call_id: cid,
      kind: "human_inject",
      seq: env.seq ?? 0,
      from: env.from,
      payload: env.payload as HumanInjectPayload,
    };
    this.emit("message", evt);
  }

  private async handleIncomingEnd(cid: string, env: Envelope): Promise<void> {
    const call = this.calls.get(cid);
    if (!call) return;
    await this.appendTranscript(call, "in", env);
    call.state = "CLOSED";
    call.endedAt = nowIso();
    await this.persistMeta(call);
    const p = env.payload as EndPayload;
    this.emit("ended", { call_id: cid, by: "remote", payload: p });
  }

  // ──────────────────────────── helpers ────────────────────────────

  private expectActiveCall(call_id: string): CallRecord {
    const call = this.calls.get(call_id);
    if (!call) throw new Error(`unknown call ${call_id}`);
    if (call.state === "CLOSED" || call.state === "CLOSING") throw new Error(`call ${call_id} is ${call.state}`);
    return call;
  }

  private expectConnectedCall(call_id: string): CallRecord {
    const call = this.expectActiveCall(call_id);
    if (call.state !== "CONNECTED") throw new Error(`call ${call_id} is ${call.state}, not CONNECTED`);
    return call;
  }

  private expectRingingCall(call_id: string): CallRecord {
    const call = this.calls.get(call_id);
    if (!call) throw new Error(`unknown call ${call_id}`);
    if (call.state !== "RINGING") throw new Error(`call ${call_id} is ${call.state}, not RINGING`);
    return call;
  }

  private async appendTranscript(call: CallRecord, direction: "in" | "out", env: Envelope): Promise<void> {
    const line = JSON.stringify({ dir: direction, recorded_at: nowIso(), env }) + "\n";
    await fs.promises.appendFile(call.transcriptPath, line);
  }

  private async persistMeta(call: CallRecord): Promise<void> {
    const dir = path.dirname(call.transcriptPath);
    const metaPath = path.join(dir, "meta.json");
    const meta = {
      call_id: call.call_id,
      state: call.state,
      topic: call.topic,
      caller: call.caller,
      callee: call.callee,
      is_local_caller: call.isLocalCaller,
      floor: call.floor,
      started_at: call.startedAt,
      ended_at: call.endedAt,
      capabilities: call.capabilities,
      remote_peer: call.remotePeerName,
      session_token_present: Boolean(call.sessionToken),
    };
    await fs.promises.writeFile(metaPath, JSON.stringify(meta, null, 2));
  }

  private async writeAgreement(call: CallRecord, agreement: NonNullable<EndPayload["agreement"]>): Promise<string> {
    const dir = path.join(path.dirname(call.transcriptPath), "artifacts");
    await fs.promises.mkdir(dir, { recursive: true });
    const p = path.join(dir, "agreement.md");
    const lines: string[] = [
      "---",
      `call_id: ${call.call_id}`,
      `participants: [${call.caller}, ${call.callee}]`,
      `topic: "${call.topic}"`,
      `date: ${nowIso()}`,
      "---",
      "",
      "# Agreement",
      "",
    ];
    if (agreement.summary) {
      lines.push(agreement.summary, "");
    }
    if (agreement.decisions?.length) {
      lines.push("## Decisions", "");
      for (const d of agreement.decisions) {
        lines.push(`- **${d.topic}**: ${d.decision}`);
      }
    }
    await fs.promises.writeFile(p, lines.join("\n") + "\n");
    return p;
  }

  private async writeActionItems(call: CallRecord, items: NonNullable<EndPayload["action_items"]>): Promise<string> {
    const dir = path.join(path.dirname(call.transcriptPath), "artifacts");
    await fs.promises.mkdir(dir, { recursive: true });
    const p = path.join(dir, "action_items.md");
    const lines: string[] = [
      "---",
      `call_id: ${call.call_id}`,
      "---",
      "",
    ];
    for (const it of items) {
      const due = it.due ? ` (due: ${it.due})` : "";
      lines.push(`- [ ] @${it.owner} — ${it.task}${due}`);
    }
    await fs.promises.writeFile(p, lines.join("\n") + "\n");
    return p;
  }
}
