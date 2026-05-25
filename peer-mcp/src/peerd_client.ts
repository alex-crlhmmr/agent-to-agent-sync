// Tiny client for the peerd control socket. Same wire format as peerd/src/control_client.ts.
// Duplicated here to keep peer-mcp self-contained.

import * as net from "node:net";
import * as readline from "node:readline";

interface PendingCall {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  onNotification?: (n: unknown) => void;
}

export interface Subscription {
  unsubscribe: () => void;
}

export class PeerdClient {
  private sock: net.Socket;
  private rl: readline.Interface;
  private nextId = 1;
  private pending: Map<number, PendingCall> = new Map();
  private closed = false;

  private constructor(sock: net.Socket) {
    this.sock = sock;
    this.rl = readline.createInterface({ input: sock });
    this.rl.on("line", (line) => this.handleLine(line));
    this.sock.on("close", () => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error("control socket closed"));
      this.pending.clear();
    });
    this.sock.on("error", (err) => {
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    });
  }

  static connect(socketPath: string): Promise<PeerdClient> {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ path: socketPath }, () => resolve(new PeerdClient(sock)));
      sock.once("error", reject);
    });
  }

  private handleLine(line: string): void {
    let obj: any;
    try { obj = JSON.parse(line); } catch { return; }
    if (typeof obj.id !== "number") return;
    const p = this.pending.get(obj.id);
    if (!p) return;
    if (obj.notification !== undefined) {
      p.onNotification?.(obj.notification);
      return;
    }
    if (p.onNotification) {
      // Subscription ack; keep the entry alive.
      return;
    }
    this.pending.delete(obj.id);
    if (obj.error) {
      const err = new Error(obj.error.message ?? "control error") as Error & { code?: string };
      err.code = obj.error.code;
      p.reject(err);
    } else {
      p.resolve(obj.result);
    }
  }

  async call<T = unknown>(method: string, params?: Record<string, unknown>, opts: { timeoutMs?: number } = {}): Promise<T> {
    if (this.closed) throw new Error("control client closed");
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      if (opts.timeoutMs && opts.timeoutMs > 0) {
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`control call timeout: ${method}`));
        }, opts.timeoutMs);
      }
      this.pending.set(id, {
        resolve: (r) => { if (timer) clearTimeout(timer); resolve(r as T); },
        reject: (e) => { if (timer) clearTimeout(timer); reject(e); },
      });
      try {
        this.sock.write(JSON.stringify({ id, method, params: params ?? {} }) + "\n");
      } catch (e) {
        this.pending.delete(id);
        if (timer) clearTimeout(timer);
        reject(e as Error);
      }
    });
  }

  subscribe(method: string, params: Record<string, unknown>, onNotification: (n: unknown) => void): Subscription {
    if (this.closed) throw new Error("control client closed");
    const id = this.nextId++;
    this.pending.set(id, {
      resolve: () => {},
      reject: () => {},
      onNotification,
    });
    this.sock.write(JSON.stringify({ id, method, params }) + "\n");
    return { unsubscribe: () => { this.pending.delete(id); } };
  }

  close(): void {
    this.closed = true;
    try { this.sock.end(); } catch { /* ignore */ }
  }
}
