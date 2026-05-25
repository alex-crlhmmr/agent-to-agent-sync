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
  SendPayload,
} from "./types.js";
import { callId, nowIso, sessionToken } from "./ids.js";
import { envelope, errorEnvelope } from "./wire.js";

const INVITE_TIMEOUT_MS = 300_000; // 5 minutes — long enough for callee to come back to terminal

export interface CallManagerOptions {
  selfName: string;
  stateDir: string;
  /** Look up the active Connection to a peer by peer name. */
  getConnection: (peerName: string) => Connection | undefined;
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
}

export interface CallMessageEvent {
  call_id: string;
  kind: "send" | "end" | "human_inject";
  seq: number;
  from: string;
  payload: SendPayload | EndPayload | HumanInjectPayload;
}

export class CallManager extends EventEmitter {
  private selfName: string;
  private stateDir: string;
  private getConnection: (peerName: string) => Connection | undefined;
  private calls: Map<string, CallRecord> = new Map();
  private pending: Map<string, PendingInvite> = new Map();

  constructor(opts: CallManagerOptions) {
    super();
    this.selfName = opts.selfName;
    this.stateDir = opts.stateDir;
    this.getConnection = opts.getConnection;
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

  async invite(peerName: string, topic: string, opts: { caller_label?: string; context_excerpt?: string; first_floor?: "caller" | "callee" } = {}): Promise<InviteResolution> {
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
      expires_at: new Date(Date.now() + INVITE_TIMEOUT_MS).toISOString(),
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
      }, INVITE_TIMEOUT_MS);
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

      default:
        return;
    }
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
    };
    this.emit("invite", evt);
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
