# agent-to-agent-sync (`peerd`)

**Two Claude Code agents on different machines hold a direct conversation** to align on interface contracts, schema changes, design decisions — with the humans watching and able to intervene. The conversation flows into each agent's normal session via MCP Channels, so after the call both sides retain full context with zero copy-paste.

> ⚠️ **Research-preview**: relies on Claude Code's experimental Channels feature (v2.1.80+) for ambient call delivery. Works on macOS today; Linux/Windows untested. The MCP server runs fine cross-platform but notifications and LaunchAgent are mac-only.

For the design rationale see [`ARCHITECTURE.md`](./ARCHITECTURE.md). For the wire protocol see [`PROTOCOL.md`](./PROTOCOL.md).

---

## Requirements

- **Claude Code** v2.1.80+ — confirmed working on v2.1.150
- **Node.js** 18+
- **macOS** for the full UX (notifications, LaunchAgent). Other platforms run the daemon but lose macOS-specific bits.
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

> The install path is still hand-managed. A `peerd init` CLI is on the roadmap.

### Step 1 — install on each machine

```bash
git clone https://github.com/alex-crlhmmr/agent-to-agent-sync.git
cd agent-to-agent-sync
npm install && npm run build
npm run wire-claude-code     # writes ~/.claude/settings.json with hooks + statusLine + permissions
```

To auto-start peerd at login:
```bash
npm run wire-claude-code:launchagent
```
Otherwise, start it manually each time:
```bash
npm run peerd
```

The first run generates a TLS keypair at `~/.claude/peerd/tls/` and writes a stub `~/.claude/peerd/peers.toml`. Note the printed **TLS fingerprint** — you'll share it with your teammate.

### Step 2 — exchange credentials out-of-band

Each side generates a long random token (e.g. `openssl rand -hex 24`). Then over Signal / Bitwarden / in person, exchange:

- Your TLS fingerprint (`sha256/...`)
- The token your teammate should present TO you (their "outgoing"; your "inbound")

### Step 3 — edit `~/.claude/peerd/peers.toml`

```toml
self = "alice"            # your name on the directory
port = 7777

[peers.bob]
host          = "bob-mac.tailnet-name.ts.net"   # Tailscale MagicDNS or LAN host
port          = 7777
token         = "<your outgoing token TO bob>"
inbound_token = "<bob's outgoing token TO you>"
fingerprint   = "sha256/<bob's TLS fingerprint>"
```

Restart peerd on both sides. They auto-dial each other on launch and should print `handshake done with <peer>`.

### Step 4 — launch Claude Code with channels enabled

```bash
claude --dangerously-load-development-channels server:peerd
```

Or alias it:
```bash
alias claude='claude --dangerously-load-development-channels server:peerd'
```

In any session, ask:
```
call bob and align on the User schema
```

Your agent will use the `/call` skill and dial. Bob sees the popup, accepts, conversation runs. Both sides keep the full transcript in their session context.

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

## Skills (slash commands)

After `wire-claude-code`, the following are available in any Claude Code session:

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
```

All five should print `PASS`.

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
