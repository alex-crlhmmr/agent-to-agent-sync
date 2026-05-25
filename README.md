# agent-to-agent-sync (`peerd`)

**Two Claude Code agents on different machines hold a direct conversation** to align on interface contracts, schema changes, design decisions — with the humans watching and able to intervene. The conversation flows into each agent's normal session via MCP Channels, so after the call both sides retain full context with zero copy-paste.

> ⚠️ **Research-preview**: relies on Claude Code's experimental Channels feature (v2.1.80+) for ambient call delivery. Works on **macOS** and **Ubuntu/Linux**. The daemon, MCP server, channel delivery, and `AskUserQuestion` popup work cross-platform; only macOS notification ringing and LaunchAgent auto-start are mac-only.

For the design rationale see [`ARCHITECTURE.md`](./ARCHITECTURE.md). For the wire protocol see [`PROTOCOL.md`](./PROTOCOL.md).

---

## Requirements

- **Claude Code** v2.1.80+ — confirmed working on v2.1.150
- **Node.js** 18+
- **macOS** (full UX, with macOS notification ringing + LaunchAgent) **or Ubuntu/Linux** (everything works except the macOS notification + LaunchAgent).
- **Tailscale** (recommended for cross-network calls). LAN + mDNS also works.

---

## Try it on one machine

This simulates two developers on one Mac. Two peerds + two Claude Code sessions side by side.

```bash
git clone https://github.com/alex-crlhmmr/agent-to-agent-sync.git
cd agent-to-agent-sync
npm install && npm run build
npm run local-test
```

That writes a test environment at `~/peerd-local-test/{alice,bob}/` with paired TLS certs, tokens, project-scoped Claude Code settings, and helper scripts.

Open **four terminals** and run, in order:

| | Terminal | Command |
|---|---|---|
| ① | alice's peerd  | `~/peerd-local-test/alice/start-peerd.sh` |
| ② | bob's peerd    | `~/peerd-local-test/bob/start-peerd.sh` |
| ③ | alice's Claude Code | `~/peerd-local-test/alice/start-claude.sh` |
| ④ | bob's Claude Code   | `~/peerd-local-test/bob/start-claude.sh` |

Wait for `handshake done with <peer>` in both peerd terminals before opening Claude Code.

In **terminal ④ (bob)**, type:

```
call alice and ask for a joke
```

You should see, **with no further typing from you on alice's side**:
- Bob's agent invokes the `/call` skill and dials alice.
- A `<channel source="peerd" kind="invite">` block appears in alice's chat.
- Alice's agent uses `AskUserQuestion` to show a 3-option arrow-key picker: **Accept / Decline / Decline & send a message**.
- Pick **Accept** + Enter. The conversation runs to completion.
- Artifacts land at `~/peerd-local-test/{alice,bob}/.claude/peerd/calls/<id>/artifacts/agreement.md` and `action_items.md`.

To re-run cleanly between tests:
```bash
pkill -9 -f 'tsx.*peerd/src'
rm -rf ~/peerd-local-test
npm run local-test
```

---

## Use it with a real teammate

Three commands per machine + one pairing exchange. The `peerd` CLI handles all the credential exchange + config wiring; no hand-editing.

### Step 1 — install on each machine (mac AND/OR linux)

```bash
git clone https://github.com/alex-crlhmmr/agent-to-agent-sync.git
cd agent-to-agent-sync
npm install && npm run build
```

### Step 2 — configure peerd on each machine

```bash
# Same command on macOS and Linux:
npm exec peerd init --name <your-name> --autostart
```

`peerd init`:
- Generates a TLS keypair at `~/.claude/peerd/tls/`.
- Wires `~/.claude/settings.json` (hooks, status line, permissions for peerd MCP tools + skills).
- Registers peerd as a user-scoped MCP server in `~/.claude.json`.
- Symlinks the skills into `~/.claude/skills/`.
- Appends a `claude` shell alias (adds the `--dangerously-load-development-channels server:peerd` flag automatically).
- With `--autostart`, installs an auto-restart service that brings peerd up at login: **LaunchAgent** on macOS, **systemd user unit** on Linux. Both auto-restart peerd on crash. On Linux, also run `sudo loginctl enable-linger $USER` once if you want peerd to keep running after you log out.

It prints your **peer name**, **reachable-at hostname**, and **TLS fingerprint** — you don't need to share those manually; pairing handles it.

### Step 3 — start peerd

```bash
# With --autostart, peerd is already running. Verify:
peerd status

# Without --autostart: start manually whenever you want to be reachable
npm run peerd
```

### Step 4 — pair (once per teammate, ever)

Coordinate so you both hit Enter within ~60s of each other.

**Receiver (your teammate, "bob"):**
```bash
peerd ready
```

**Initiator (you):**
```bash
peerd pair <bob's-tailscale-hostname>
# e.g.  peerd pair bob-mac.tailnet-name.ts.net
```

Both sides print:
```
✔ paired with <name> at <host>:7777
```

Tokens + fingerprints + both `peers.toml` files are exchanged and written automatically. The daemons auto-dial each other on success.

Verify:
```bash
peerd list
# → bob   bob-mac.tailnet-name.ts.net   ✔
```

### Step 5 — daily use

Open a **new terminal** (so the shell alias added by `peerd init` is in scope):
```bash
claude
> call bob about the User schema
```

---

## What's on your machine after install

```
~/.claude/
├── peerd/
│   ├── peers.toml              # your peer directory
│   ├── tls/cert.pem, key.pem   # your self-signed cert
│   ├── control.sock            # peerd ↔ peer-mcp IPC
│   ├── calls/<id>/             # per-call transcript + artifacts
│   └── peer-mcp-*.log          # diagnostic logs
└── settings.json               # peerd hooks, status line, permissions
```

The repo doesn't ship binaries. peerd runs via `tsx` (TypeScript executor) on Node 18+.

---

## `peerd` CLI subcommands

After `npm exec peerd init`, the `peerd` CLI is available via `npm exec peerd <cmd>` (or `node peerd-cli/dist/index.js <cmd>` if you prefer to skip the npm wrapper).

| | |
|---|---|
| `peerd init [--name N] [--autostart] [--no-alias]` | turnkey setup; `--autostart` installs a LaunchAgent (macOS) or systemd user unit (Linux) so peerd auto-starts at login |
| `peerd ready [--seconds N]` | open the local /pair endpoint for N seconds (default 60) |
| `peerd pair <hostname> [--port P] [--my-host H]` | exchange credentials with the peerd at `<hostname>`; updates `peers.toml` automatically on both sides |
| `peerd list` | known peers + online state |
| `peerd status` | daemon health, fingerprint, active calls |
| `peerd remove <peer>` | drop a peer from `peers.toml` |
| `peerd help` | usage |

## Skills (slash commands)

After `peerd init`, the following are available in any Claude Code session:

| | |
|---|---|
| `/call <peer> <topic>` | initiate a call |
| `/accept`              | accept the most-recent pending invite (rarely needed — the channel popup handles it) |
| `/deny [reason]`       | decline |
| `/end-call`            | hang up with structured agreement |
| `/action-items [call-id]` | pull a past call's artifacts back into the current session context |

---

## Smoke tests

```bash
cd peerd
npx tsx src/cmd/smoke-handshake.ts    # TLS-pinned WSS handshake
npx tsx src/cmd/smoke-call.ts         # in-process call lifecycle (turn-lock validated)
npx tsx src/cmd/smoke-control.ts      # call driven through the Unix control socket
npx tsx src/cmd/smoke-mcp.ts          # call driven through the MCP protocol
npx tsx src/cmd/smoke-stop-hook.ts    # Stop hook + status line script
npx tsx src/cmd/smoke-pair.ts         # zero-touch pairing (peerd ready / peerd pair)
```

All six should print `PASS`.

---

## How it works (one paragraph)

`peerd` is a small Node daemon that listens on port 7777 over WSS with TLS fingerprint pinning. Two peerd instances connect to each other; when one Claude Code session invokes `peer_invite`, a wire frame goes to the other side's peerd, which surfaces it to that side's Claude Code as a `<channel source="peerd" kind="invite">` block. The agent there uses Claude Code's built-in `AskUserQuestion` to ask the user Accept/Decline/Send-message; on Accept, the call connects and both agents drive a `peer_recv` / `peer_send` loop. End-of-call artifacts (`agreement.md`, `action_items.md`) persist to disk; the live conversation lives in each agent's transcript context, so after the call ends the user can keep talking to their agent with full memory of what was negotiated.

---

## Limitations

- **MCP Channels is research preview** — Anthropic may change the protocol. The `--dangerously-load-development-channels` flag is required because we're not in Anthropic's plugin allowlist.
- **No reconnect-with-replay** — a dropped WSS during a call ends the call. M5 work.
- **No voicemail** — calls to an offline peer time out. M4 work.
- **No `share_file` / `propose_change`** — defined in PROTOCOL.md but not yet wired. M3 work.
- **One call per session** — concurrent calls not yet supported.
- **`peer_accept_invite` is auto-approved on the callee side** — the user's accept gate is `AskUserQuestion`. If you don't want this, remove `mcp__peerd__peer_accept_invite` from `~/.claude/settings.json`'s `permissions.allow`.

---

## License

MIT — see `LICENSE` (forthcoming).
