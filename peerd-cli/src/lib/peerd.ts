// Shared helpers for talking to peerd from the CLI.
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { parse as parseToml, stringify as stringifyToml } from "@iarna/toml";

export function stateDir(): string {
  return process.env.PEERD_STATE_DIR ?? path.join(os.homedir(), ".claude", "peerd");
}

export function controlSocketPath(): string {
  return path.join(stateDir(), "control.sock");
}

export function peersTomlPath(): string {
  return path.join(stateDir(), "peers.toml");
}

/** Minimal JSON-line RPC client for peerd's control socket. */
export class ControlClient {
  private sock: net.Socket;
  private rl: readline.Interface;
  private nextId = 1;
  private pending = new Map<number, { resolve: (r: any) => void; reject: (e: Error) => void }>();

  private constructor(sock: net.Socket) {
    this.sock = sock;
    this.rl = readline.createInterface({ input: sock });
    this.rl.on("line", (line) => {
      try {
        const obj: any = JSON.parse(line);
        if (typeof obj.id !== "number") return;
        const p = this.pending.get(obj.id);
        if (!p) return;
        if (obj.notification !== undefined) return; // we don't subscribe here
        this.pending.delete(obj.id);
        if (obj.error) {
          const e = new Error(obj.error.message ?? "control error") as Error & { code?: string };
          e.code = obj.error.code;
          p.reject(e);
        } else {
          p.resolve(obj.result);
        }
      } catch {/* ignore */}
    });
    this.sock.on("close", () => {
      for (const p of this.pending.values()) p.reject(new Error("control socket closed"));
      this.pending.clear();
    });
    this.sock.on("error", (e) => {
      for (const p of this.pending.values()) p.reject(e);
      this.pending.clear();
    });
  }

  static connect(socketPath: string = controlSocketPath()): Promise<ControlClient> {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ path: socketPath }, () => resolve(new ControlClient(sock)));
      sock.once("error", reject);
    });
  }

  async call<T = unknown>(method: string, params: Record<string, unknown> = {}, opts: { timeoutMs?: number } = {}): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      if (opts.timeoutMs) {
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`control call timeout: ${method}`));
        }, opts.timeoutMs);
      }
      this.pending.set(id, {
        resolve: (r) => { if (timer) clearTimeout(timer); resolve(r as T); },
        reject: (e) => { if (timer) clearTimeout(timer); reject(e); },
      });
      this.sock.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }

  close(): void {
    try { this.sock.end(); } catch { /* ignore */ }
  }
}

export interface PeersTomlEntry {
  host: string;
  port: number;
  token: string;
  inbound_token: string;
  fingerprint?: string;
}

export interface PeersToml {
  self: string;
  port: number;
  peers: Record<string, PeersTomlEntry>;
}

export function readPeersToml(): PeersToml {
  const p = peersTomlPath();
  if (!fs.existsSync(p)) {
    return { self: os.userInfo().username, port: 7777, peers: {} };
  }
  const raw = fs.readFileSync(p, "utf8");
  const parsed = parseToml(raw) as any;
  const peers: Record<string, PeersTomlEntry> = {};
  for (const [name, entry] of Object.entries((parsed.peers ?? {}) as Record<string, any>)) {
    peers[name] = {
      host: String(entry.host),
      port: Number(entry.port ?? 7777),
      token: String(entry.token ?? ""),
      inbound_token: String(entry.inbound_token ?? ""),
      fingerprint: entry.fingerprint ? String(entry.fingerprint) : undefined,
    };
  }
  return {
    self: String(parsed.self ?? os.userInfo().username),
    port: Number(parsed.port ?? 7777),
    peers,
  };
}

export function writePeersToml(t: PeersToml): void {
  const obj: any = { self: t.self, port: t.port, peers: {} };
  for (const [name, e] of Object.entries(t.peers)) {
    obj.peers[name] = {
      host: e.host,
      port: e.port,
      token: e.token,
      inbound_token: e.inbound_token,
    };
    if (e.fingerprint) obj.peers[name].fingerprint = e.fingerprint;
  }
  const dir = path.dirname(peersTomlPath());
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(peersTomlPath(), stringifyToml(obj));
}
