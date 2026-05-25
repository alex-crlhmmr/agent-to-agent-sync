import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { parse as parseToml } from "@iarna/toml";

export interface PeerEntry {
  host: string;
  port: number;
  token: string;          // outgoing bearer we present TO this peer
  inboundToken?: string;  // bearer we EXPECT FROM this peer (defaults to token if unset)
  fingerprint?: string;
}

export interface Config {
  self: string;
  port: number;
  stateDir: string;
  controlSocketPath: string;
  peers: Record<string, PeerEntry>;
}

export async function loadConfig(opts: {
  stateDir?: string;
  configPath?: string;
} = {}): Promise<Config> {
  const stateDir =
    opts.stateDir ??
    process.env.PEERD_STATE_DIR ??
    path.join(os.homedir(), ".claude", "peerd");

  for (const sub of ["tls", "calls", "inbox", "voicemail"]) {
    await fs.promises.mkdir(path.join(stateDir, sub), { recursive: true });
  }

  const configPath = opts.configPath ?? path.join(stateDir, "peers.toml");

  if (!fs.existsSync(configPath)) {
    const stub = `# peerd config — generated stub. Edit and add peers below.
self = "${os.userInfo().username}"
port = 7777

# Example peer entry:
# [peers.alex]
# host = "alex-mac.tailnet-name.ts.net"
# port = 7777
# token         = "sk_peer_OUTGOING"   # bearer WE present to Alex
# inbound_token = "sk_peer_INCOMING"   # bearer we EXPECT from Alex
# fingerprint   = "sha256/..."         # Alex's TLS cert fingerprint
`;
    await fs.promises.writeFile(configPath, stub);
  }

  const raw = await fs.promises.readFile(configPath, "utf8");
  const parsed = parseToml(raw) as Record<string, unknown>;

  const peers: Record<string, PeerEntry> = {};
  const peersRaw = (parsed.peers ?? {}) as Record<string, Record<string, unknown>>;
  for (const [name, entry] of Object.entries(peersRaw)) {
    const host = String(entry.host ?? "");
    const port = Number(entry.port ?? 7777);
    const token = String(entry.token ?? "");
    const inboundToken = entry.inbound_token ? String(entry.inbound_token) : undefined;
    const fingerprint = entry.fingerprint ? String(entry.fingerprint) : undefined;
    if (!host || !token) {
      console.warn(`[peerd] peer "${name}" is missing host or token; skipping.`);
      continue;
    }
    peers[name] = { host, port, token, inboundToken, fingerprint };
  }

  return {
    self: String(parsed.self ?? os.userInfo().username),
    port: Number(parsed.port ?? 7777),
    stateDir,
    controlSocketPath: path.join(stateDir, "control.sock"),
    peers,
  };
}
