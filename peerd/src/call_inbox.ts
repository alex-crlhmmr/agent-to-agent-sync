// Per-call event queue + long-poll receive helper.
// Sits on top of CallManager events and gives the control socket a
// "give me the next event on this call or wait up to N seconds" API.

import { CallManager, CallMessageEvent } from "./call_manager.js";

export type CallInboxEvent =
  | { kind: "send" | "human_inject" | "file_shared" | "change_proposed" | "file_ref_shared" | "paused" | "resumed"; seq: number; from: string; payload: unknown }
  | { kind: "ended"; by: "local" | "remote"; payload?: unknown };

interface Waiter {
  resolve: (evt: CallInboxEvent) => void;
  timer: NodeJS.Timeout;
}

export class CallInbox {
  private queues: Map<string, CallInboxEvent[]> = new Map();
  private waiters: Map<string, Waiter[]> = new Map();

  constructor(cm: CallManager) {
    cm.on("message", (evt: CallMessageEvent) => {
      if (evt.kind === "end") return;
      this.push(evt.call_id, { kind: evt.kind, seq: evt.seq, from: evt.from, payload: evt.payload });
    });
    cm.on("ended", (evt: { call_id: string; by: "local" | "remote"; payload?: unknown }) => {
      this.push(evt.call_id, { kind: "ended", by: evt.by, payload: evt.payload });
    });
  }

  push(callId: string, evt: CallInboxEvent): void {
    const w = this.waiters.get(callId);
    if (w && w.length > 0) {
      const next = w.shift()!;
      clearTimeout(next.timer);
      next.resolve(evt);
      if (w.length === 0) this.waiters.delete(callId);
      return;
    }
    const q = this.queues.get(callId) ?? [];
    q.push(evt);
    this.queues.set(callId, q);
  }

  async recv(callId: string, timeoutMs: number): Promise<CallInboxEvent | { kind: "timeout" }> {
    const q = this.queues.get(callId);
    if (q && q.length > 0) {
      const evt = q.shift()!;
      if (q.length === 0) this.queues.delete(callId);
      return evt;
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const list = this.waiters.get(callId);
        if (list) {
          const idx = list.findIndex((w) => w.timer === timer);
          if (idx >= 0) list.splice(idx, 1);
          if (list.length === 0) this.waiters.delete(callId);
        }
        resolve({ kind: "timeout" });
      }, timeoutMs);
      const arr = this.waiters.get(callId) ?? [];
      arr.push({ resolve, timer });
      this.waiters.set(callId, arr);
    });
  }
}
