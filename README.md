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
# Same command on macOS and Linux. The `--` after `peerd` is REQUIRED;
# without it, npm strips the script's flags before the CLI sees them
# (you'll see warnings like "Unknown cli config '--name'").
npm exec peerd -- init --name <your-name> --autostart
```

> **First-run only.** If you re-run `peerd init` later, it sees the existing `peers.toml` and **does not** overwrite the `self = "..."` line. If you need a different name, `rm ~/.claude/peerd/peers.toml` first, then re-run init.

`peerd init`:
- Generates a TLS keypair at `~/.claude/peerd/tls/`.
- Wires `~/.claude/settings.json` (hooks, status line, permissions for peerd MCP tools + skills).
- Registers peerd as a user-scoped MCP server in `~/.claude.json`.
- Symlinks the skills into `~/.claude/skills/`.
- Appends a `claude` shell alias to your `.zshrc` / `.bashrc` / `.bash_profile` (whichever exist). The alias adds `--dangerously-load-development-channels server:peerd` automatically.
- With `--autostart`, installs an auto-restart service that brings peerd up at login: **LaunchAgent** on macOS, **systemd user unit** on Linux. Both auto-restart peerd on crash.

It prints your **peer name**, **reachable-at hostname**, and **TLS fingerprint** — you don't need to share those manually; pairing handles it.

#### On Ubuntu, also enable linger (one-time, optional)

If you want peerd to keep running after you log out of the desktop session:
```bash
sudo loginctl enable-linger $USER
```
Without this, the systemd user units shut down when your last session ends — peerd would only run while you're logged in.

### Step 3 — start peerd

```bash
# With --autostart, peerd is already running. Verify:
npm exec peerd status
# → daemon: ✔ running

# Without --autostart, start manually whenever you want to be reachable:
npm run peerd
```

If status says `daemon: ✘ not running` and you used `--autostart` on Linux:
```bash
systemctl --user status peerd          # see why it failed
journalctl --user -u peerd -n 50       # logs
```

### Step 4 — pair (once per teammate, ever)

Coordinate so you both hit Enter within ~60s of each other. Both sides need to be logged in and have peerd running.

**Receiver (your teammate, "bob"):**
```bash
npm exec peerd -- ready
```

**Initiator (you):**
```bash
npm exec peerd -- pair <bob's-tailscale-hostname>
# e.g.  npm exec peerd -- pair bob-mac.tailnet-name.ts.net
```

Both sides print:
```
✔ paired with <name> at <host>:7777
```

Tokens + fingerprints + both `peers.toml` files are exchanged and written automatically. The daemons auto-dial each other on success.

Verify:
```bash
npm exec peerd list
# → bob   bob-mac.tailnet-name.ts.net   ✔
```

### Step 5 — daily use

**Open a new terminal** (so the `claude` shell alias added by `peerd init` is in scope) and just run:
```bash
claude
```

By default a new claude session is **NOT reachable** by callers. To opt in this session for incoming calls:
```
> /make-available-for-call work
```
(label is optional — caller's session-picker will show it). The session stays reachable until `/unavailable` is run or claude exits. To open every session as reachable automatically, prefix the launch with `PEERD_AVAILABLE=1 claude` (or `PEERD_AVAILABLE=work claude` for a label).

You should see at launch:
```
Listening for channel messages from: server:peerd
Experimental · inbound messages will be pushed into this session…
```

If you don't see that line, the alias isn't loaded — either you're using an existing terminal (open a new one) or your shell config doesn't auto-source. Quick fix in the current shell:
```bash
source ~/.zshrc   # or ~/.bashrc on bash
alias claude      # should print: claude='claude --dangerously-load-development-channels server:peerd'
```

As a one-off override (no alias needed):
```bash
claude --dangerously-load-development-channels server:peerd
```

Then in chat:
```
> call bob about the User schema
```

---

## Adding a 3rd, 4th, … teammate

peerd is pair-wise — each pair of devs pairs once. To add a new person:

1. **New person follows Steps 1–3 above** on their own machine (clone, install, `peerd init`).
2. **They pair with each existing peer separately**, using the same `peerd ready` / `peerd pair <hostname>` dance. If you're adding `charlie`, that's 2 pairings (charlie↔you, charlie↔bob). With N people total, N×(N−1)/2 pairings team-wide; for a team of 3-5 this is fast and only done once.

No central registry or service to update. Each person manages their own `peers.toml` via the pair command. `peerd list` on any machine shows that side's peer directory.

---

## Multi-session behavior (one machine, multiple claude sessions)

Sessions are **opt-in to receive**. A new session is silent until the user runs `/make-available-for-call` (or `PEERD_AVAILABLE=1 claude` at launch).

When a peer calls, default routing is:
- **Caller may target a specific session** via the picker — `peer_invite` is preceded by `peer_list_remote_sessions`. If 2+ sessions are available, the user picks; if 1, auto-routes; if 0, fails fast.
- **If caller doesn't target**, the **newest** opted-in session gets the popup. Older opted-in sessions stay silent.
- macOS notification ring fires once per invite.
- A session that ran `/unavailable` (or never opted in) is invisible to callers.

To take over an active call from another session, you can't easily — the call is bound to the session that accepted. For invites still ringing, `/exit`ing the session that has the popup hands off to whoever's now-newest.

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
| `peerd sessions` | local claude sessions reachable for calls (those that ran `/make-available-for-call`) |
| `peerd status` | daemon health, fingerprint, active calls |
| `peerd remove <peer>` | drop a peer from `peers.toml` |
| `peerd help` | usage |

## Skills (slash commands)

After `peerd init`, the following are available in any Claude Code session:

| | |
|---|---|
| `/make-available-for-call [label]` | opt THIS session in to receive incoming calls (label is optional, shown to callers in picker) |
| `/unavailable`         | opt this session out |
| `/call <peer> <topic>` | initiate a call (will list & pick a target session on the peer) |
| `/accept`              | accept the most-recent pending invite (rarely needed — popup handles it) |
| `/deny [reason]`       | decline |
| `/end-call`            | hang up with structured agreement |
| `/action-items [call-id]` | pull a past call's artifacts back into context |

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
npx tsx src/cmd/smoke-opt-in.ts       # opt-in subscriber routing + session discovery
```

All seven should print `PASS`.

---

## How it works (one paragraph)

`peerd` is a small Node daemon that listens on port 7777 over WSS with TLS fingerprint pinning. Two peerd instances connect to each other; when one Claude Code session invokes `peer_invite`, a wire frame goes to the other side's peerd, which surfaces it to that side's Claude Code as a `<channel source="peerd" kind="invite">` block. The agent there uses Claude Code's built-in `AskUserQuestion` to ask the user Accept/Decline/Send-message; on Accept, the call connects and both agents drive a `peer_recv` / `peer_send` loop. End-of-call artifacts (`agreement.md`, `action_items.md`) persist to disk; the live conversation lives in each agent's transcript context, so after the call ends the user can keep talking to their agent with full memory of what was negotiated.

---

## Troubleshooting

| Symptom | Check |
|---|---|
| `peerd: command not found` after `peerd init` | Open a NEW terminal (the alias is only loaded for newly-spawned shells). Or `source ~/.zshrc` / `~/.bashrc`. |
| Claude Code launches without the `Listening for channel messages…` banner | The `claude` shell alias isn't loaded. Run `alias claude` — it should print the aliased command. If not, see row above. |
| `peerd status` says daemon not running | macOS: `launchctl load ~/Library/LaunchAgents/com.peerd.daemon.plist`. Linux: `systemctl --user status peerd` + `journalctl --user -u peerd -n 50`. |
| `peerd pair` says "remote not in pairing mode" | The other side must run `peerd ready` first; pairing window is 60s. |
| `peerd list` shows peer as `—` (offline) | `tailscale ping <peer-hostname>` to verify tailnet reachability; check the peer's `peerd status`. |
| Mac's tailscale not on PATH | `which tailscale` empty? The Mac App Store version puts the CLI in the .app bundle. Either install via `brew install --cask tailscale` (CLI auto-on-PATH) or manually add `/Applications/Tailscale.app/Contents/MacOS` to PATH. |
| Lost peers / corrupted state | `peerd remove <name>` to drop a peer entry, or `rm ~/.claude/peerd/peers.toml` + re-run `peerd init` + re-pair. |
| Live peer-mcp logs | `tail -f ~/.claude/peerd/peer-mcp-*.log` — every channel emit, every elicitation attempt, every error. |

---

## Limitations

- **MCP Channels is research preview** — Anthropic may change the protocol. The `--dangerously-load-development-channels` flag is required because we're not in Anthropic's plugin allowlist.
- **No reconnect-with-replay** — a dropped WSS during a call ends the call. M5 work.
- **No voicemail** — calls to an offline peer time out. M4 work.
- **No `share_file` / `propose_change`** — defined in PROTOCOL.md but not yet wired. M3 work.
- **One call per session** — concurrent calls not yet supported.
- **`peer_accept_invite` is auto-approved on the callee side** — the user's accept gate is `AskUserQuestion`. If you don't want this, remove `mcp__peerd__peer_accept_invite` from `~/.claude/settings.json`'s `permissions.allow`.
- **Multi-session popup goes to the OLDEST session** — see the section above. If that's the wrong one for you, close the older sessions or `/exit` them.

---

## License

MIT — see `LICENSE` (forthcoming).
