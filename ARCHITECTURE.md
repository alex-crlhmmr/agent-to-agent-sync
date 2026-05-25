# Agent-to-Agent Sync — Architecture & Protocol

**Status:** v0 design • **Audience:** implementers and reviewers • **Working name:** `peerd`

A system that lets two Claude Code agents on two different developer machines hold a direct, structured conversation to align on contracts and decisions — so the humans don't have to play telephone between their own agents. The conversation lives inside each developer's normal Claude Code session, with full context preserved on both sides after the call.

---

## 1. Goals & Non-goals

### Goals

1. **Two Claude Code instances on different machines can hold a turn-by-turn conversation** initiated by either side, with the other side getting an "incoming call" notification at a natural pause in its own work.
2. **Zero Claude Code UX degradation** — no `/clear`, no copy-paste, no manual context dump. After the call, each developer can keep talking to their own agent and reference the call's content like any other prior turn.
3. **Human-in-the-loop at every moment** — either developer can interrupt their side mid-call, inject a directive, or end the call.
4. **No web UI** — monitoring and intervention happen inside Claude Code's terminal.
5. **Works on a LAN and over Tailscale** — same protocol either way.
6. **Calls produce durable artifacts** — interface specs, agreements, action items — that survive past the session.

### Non-goals (v1)

- More than two participants per call.
- Cross-organization calls (assume both devs are trusted teammates with shared Tailscale tailnet).
- Voice/audio. Text only.
- A web dashboard. The terminal is the surface.
- Built-in code execution sandbox shared between agents (each agent acts in its own repo).

---

## 2. High-level architecture

Two pieces per developer machine. No central server.

```
   Alex's Mac                                  Bob's Mac
   ┌──────────────────────────┐               ┌──────────────────────────┐
   │  Claude Code (TUI)       │               │  Claude Code (TUI)       │
   │   │ stdio                │               │   │                      │
   │   ▼                      │               │   ▼                      │
   │  peer-mcp  (MCP server)  │               │  peer-mcp  (MCP server)  │
   │   │ unix socket          │               │   │                      │
   │   ▼                      │               │   ▼                      │
   │  peerd  (LaunchAgent)    │ ◄── WSS ────► │  peerd  (LaunchAgent)    │
   │   • WS listener :7777    │   bearer +    │   • WS listener :7777    │
   │   • mDNS advertise       │   per-call    │   • mDNS advertise       │
   │   • Tailscale-aware      │   session     │   • Tailscale-aware      │
   │   • call inbox           │   token       │   • call inbox           │
   │   • artifact writer      │               │   • artifact writer      │
   └──────────────────────────┘               └──────────────────────────┘
                          LAN  or  Tailscale (preferred)
```

- **`peerd`** runs always (Mac LaunchAgent), holds the network listener and the persistent local state (call inbox, action items, interface artifacts). Survives Claude Code restarts.
- **`peer-mcp`** is the per-session MCP server Claude Code spawns. Thin façade — talks to local `peerd` over a Unix domain socket, exposes a small tool vocabulary to Claude.
- **Stop hook + skills** wire the user-facing UX (incoming call banner, `/accept`, `/deny`, `/end-call`, `/action-items`).

---

## 3. Networking

### Discovery

**Primary (recommended): Tailscale.** Each developer's Mac runs the Tailscale daemon and joins the team tailnet. Each machine gets a stable `100.x.y.z` address and a MagicDNS name (`alex-macbook.tailnet-name.ts.net`). `peerd` binds `0.0.0.0:7777`; ACLs on the tailnet limit who can connect. Works identically on office LAN, home, hotel WiFi, anywhere.

**Fallback (same LAN): mDNS.** `peerd` advertises `_claude-peer._tcp.local` with TXT record `dev=<name>` and resolves peers via Bonjour. Useful if Tailscale is unavailable or for a quick local test.

**Manual override:** `~/.claude/peerd/peers.toml`:

```toml
[peers.bob]
host = "bob-macbook.tailnet-name.ts.net"
port = 7777
token = "..."            # bearer for outgoing calls to Bob

[peers.alex]
host = "alex-macbook.tailnet-name.ts.net"
port = 7777
token = "..."
```

### Transport

WebSocket Secure (WSS) on port 7777. TLS via self-signed cert pinned in the config file (over Tailscale the cert is mostly belt-and-suspenders). Heartbeat ping every 15s. Auto-reconnect with `last_seq` cursor on transient drops; messages buffered for 60s.

### Auth

- **Per-peer bearer token** — long-lived, exchanged once out-of-band (Signal, in person, password manager). Carried in the WS upgrade header.
- **Per-call session token** — issued by the *callee's* `peerd` on accept, scoped to the single call ID, expires when the call ends. Both sides include it in every message of the call.

This means: even if a long-lived bearer leaks, an attacker can ring you but can't impersonate an in-progress call. And an accepted call can't be hijacked.

---

## 4. Components

### 4.1 `peerd` — the daemon

A small Go binary, ~1500 LOC target. Runs as `~/Library/LaunchAgents/com.user.peerd.plist`. Responsibilities:

- WebSocket listener on `:7777`; one connection per active peer.
- Outbound WebSocket to a peer when initiating a call.
- mDNS advertise + browse.
- Maintain authoritative state for: known peers, active calls, call inbox (pending invites), call history.
- Write/read these files:
  - `~/.claude/peerd/inbox/<session-id>.json` — pending invites (read by Stop hook)
  - `~/.claude/peerd/calls/<call-id>/transcript.jsonl` — durable call log
  - `~/.claude/peerd/calls/<call-id>/artifacts/` — interface specs, action items, agreements
  - `~/.claude/peerd/peers.toml` — peer directory
- Accept commands from `peer-mcp` over a Unix domain socket at `~/.claude/peerd/control.sock`.

### 4.2 `peer-mcp` — the MCP server

Per-session process spawned by Claude Code via `~/.mcp.json`. Speaks MCP to Claude on stdio, speaks a small RPC to `peerd` over the Unix socket. Stateless — `peerd` is source of truth. Exposes the tools in §6.

### 4.3 Stop hook

Configured in `~/.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [{
      "command": "peer-check-inbox --session $CLAUDE_SESSION_ID"
    }]
  }
}
```

`peer-check-inbox` reads `~/.claude/peerd/inbox/<session-id>.json` and, if there's a pending invite, returns an `additionalContext` block:

```
📞 Incoming peer call from alex@layer-a-dev
   Topic: "User schema sync"
   Sent: 14s ago
   Reply /accept to take the call, /deny to decline, or /vmail to read a queued message.
```

Fires at the end of every assistant response — exactly the moment the user described: "latest task done / waiting for input."

### 4.4 Skills

Plain Claude Code skills under `~/.claude/skills/`:

- **`/accept`** — accepts the pending invite for the current session, then enters the call loop (see §7).
- **`/deny [reason]`** — declines the pending invite, optionally with a short note shipped back to the caller.
- **`/call <peer> <topic>`** — initiates an outgoing call. Bob types `/call alex User schema sync` and his agent enters the call loop, ringing Alex's side.
- **`/vmail`** — surfaces queued asynchronous messages (left when the callee was busy or offline).
- **`/action-items [call-id]`** — pulls the action items from a recent call into the current session for reference.
- **`/end-call`** — manually end the active call from outside an Esc-yield.

---

## 5. Wire protocol (`peerd` ↔ `peerd`)

All messages are JSON over WSS. Common envelope:

```json
{
  "v": 1,
  "call_id": "c_01H...",
  "seq": 42,
  "from": "alex",
  "ts": "2026-05-23T14:02:11.421Z",
  "type": "send | share_file | propose_change | pause | resume | end | human_inject | invite | invite_response | ack",
  "payload": { ... }
}
```

### Message types

- **`invite`** — `{topic, caller_session_id, capabilities, suggested_artifacts: []}`. Creates a pending invite on the callee's side; surfaces via Stop hook + macOS notification.
- **`invite_response`** — `{accepted: bool, reason?, session_token?}`.
- **`send`** — `{text}`. Normal dialog turn.
- **`share_file`** — `{path, content?, ref?, hash, preview, reason}`. Either inline content (small files) or a reference + preview (large files). Receiver may call `peer_fetch(ref)` to pull full content on demand.
- **`propose_change`** — `{file, diff, rationale, requires_human_approval: bool}`. Explicit "I propose this change on your side." Receiver's agent may apply (with human gate) or counter-propose.
- **`pause`** — `{reason, eta_seconds?}`. "Hold, I'm doing something locally."
- **`resume`** — `{}`. Counterpart to pause.
- **`human_inject`** — `{tag: "HUMAN-ALEX", text}`. A direct human note injected mid-call.
- **`end`** — `{agreement?, action_items?: [], artifacts?: []}`. Structured close.
- **`ack`** — `{ack_seq}`. Delivery confirmation; used for reconnect resync.

Strict turn discipline: only one side may emit a `send` (or `share_file` / `propose_change`) at a time. The other must be in receive mode. Out-of-turn messages get rejected with `OUT_OF_TURN`. `human_inject`, `pause`, `resume`, and `end` are valid from either side at any time.

---

## 6. Tool vocabulary (`peer-mcp` → Claude)

These are the tools Claude actually calls during a call. Each tool's description tells Claude when to use it. All blocking calls support cancellation via Esc.

| Tool | Inputs | Returns | Blocking? |
|---|---|---|---|
| `peer_invite` | `peer, topic, capabilities?` | `{call_id, accepted, reason?}` | yes, until callee responds or times out |
| `peer_recv` | `timeout_s? = 300` | `{kind, payload}` (next message from peer) | yes, long-poll |
| `peer_send` | `text` | `{ok}` | no |
| `peer_share_file` | `path, mode: "inline"\|"ref", excerpt?, reason` | `{ok}` | no |
| `peer_propose_change` | `file, diff, rationale, requires_human_approval = true` | `{ok}` | no |
| `peer_fetch` | `ref` | `{content, hash}` | yes, short |
| `peer_pause` | `reason, eta_seconds?` | `{ok}` | no |
| `peer_resume` | | `{ok}` | no |
| `peer_end` | `agreement?, action_items?` | `{call_id, artifacts: []}` | no |
| `peer_status` | | `{call_state, peer_present, last_msg_age_s, pending_human_notes}` | no |

The call loop on each side is a `peer_recv → reason → peer_send / peer_share_file / peer_propose_change / peer_end` cycle. The skill scaffolds this with explicit instructions to the agent: how to push back, when to share code vs. propose a change, when to end.

---

## 7. Call state machine

```
              ┌──────────┐
              │  IDLE    │
              └────┬─────┘
                   │  peer_invite()
                   ▼
              ┌──────────┐
              │ DIALING  │ ◄── waits for invite_response
              └────┬─────┘
                   │  accepted=true
                   ▼
              ┌──────────┐
              │CONNECTED │ ◄── peer_recv ↔ peer_send loop
              └────┬─────┘
            ┌──────┼──────┐
            │      │      │
       peer_pause  │  human_inject
            │      │      │
            ▼      │      │
        ┌─────────┐│      │
        │ PAUSED  ││      │ (no transition; just annotates)
        └────┬────┘│      │
             │ peer_resume│
             └──────┘      │
                   │       │
                   ▼  peer_end / Esc-yield-end / timeout
              ┌──────────┐
              │  CLOSING │
              └────┬─────┘
                   │  artifacts written, transcript sealed
                   ▼
              ┌──────────┐
              │  CLOSED  │
              └──────────┘

(Callee side mirrors: IDLE → RINGING (invite received) → CONNECTED → ...)
```

`peerd` is the authority on state. If `peer-mcp` restarts (e.g., Claude Code reopens), it pulls current state from `peerd`. The session JSONL on Claude Code's side preserves the in-context view.

---

## 8. End-to-end call walkthroughs

### 8.1 Scenario A — Bob calls Alex to align on a contract

1. Bob, mid-session, types `/call alex User schema sync`.
2. Bob's `peer-mcp` calls `peerd.invite("alex", "User schema sync")`. `peerd` opens a WSS to `alex-macbook.tailnet…:7777`, sends an `invite` frame, returns a `call_id` to `peer-mcp`. Tool returns `{call_id, accepted: pending}`. The skill enters a `peer_recv` wait.
3. On Alex's machine, `peerd` writes the invite to `~/.claude/peerd/inbox/<alex-session>.json` and fires a macOS notification. Alex's Claude Code finishes its current response; the Stop hook reads the inbox and emits the 📞 banner.
4. Alex types `/accept`. Skill calls `peer_accept(call_id)`, `peerd` returns `invite_response{accepted: true, session_token}` to Bob, and Alex's skill enters its own `peer_recv ↔ peer_send` loop.
5. Bob's pending `peer_recv` had been waiting for an `invite_response`; once `accepted=true` lands, Bob's skill instructs the agent: *"Connected to @alex. Open with your proposal — focus on the User schema contract."* Bob's agent emits `peer_send("I'm planning to emit User{id: ULID, email: string, created_ts: int64 unix-ms}. Will that fit your ingest?")`.
6. Alex's `peer_recv` returns with Bob's message. Alex's agent reasons, pushes back: `peer_send("ts as RFC3339 string, not unix-ms — our parser is strict. Otherwise fine.")`.
7. Three more turns. Bob's agent calls `peer_share_file(path="schemas/user.ts", mode="inline", reason="here's the type I'd ship")`. Alex's agent reads it, proposes one tweak via `peer_propose_change`. Bob's agent reads the proposal, accepts in chat.
8. Either side calls `peer_end(agreement: { ... }, action_items: [{owner: "bob", task: "implement User emitter"}, {owner: "alex", task: "tighten ingest validator"}])`.
9. `peerd` on each side writes `~/.claude/peerd/calls/<id>/agreement.md` and `action_items.md`. Skill exits. Bob's prompt is free again. Bob types: "great, let's start on my side — what was the exact field ordering Alex wanted?" His Claude reads back the relevant `peer_recv` tool result from earlier in the same session.

### 8.2 Scenario B — Bob is busy, Alex leaves voicemail

1. Alex calls. Bob's agent is mid-tool-use; Stop hook doesn't fire yet because the response isn't complete.
2. Alex's skill, after `peer_invite` times out at 60s, prompts Alex's agent: *"Bob didn't answer. Leave a voicemail summarizing what you need, or retry?"* Alex's agent calls `peer_voicemail("re: User schema — flagged a type mismatch on the timestamp; lmk when free")`.
3. `peerd` on Bob's side persists the voicemail to the inbox. Bob's agent eventually finishes its current task; Stop hook fires; banner now reads: *"📬 Voicemail from alex: …"*
4. Bob types `/vmail`. Skill reads the message into Bob's transcript. Bob says "ok call him back" → `/call alex re: voicemail`. Normal call flow.

### 8.3 Scenario C — Human intervention mid-call

1. Bob is in a call, agents are negotiating. Bob notices the conversation drifting — Alex's agent is over-engineering.
2. Bob hits Esc. The in-flight `peer_recv` cancels.
3. Skill catches cancellation and prints: `Yield to you. Type a note, /resume to release with no note, /end to hang up.`
4. Bob types: `tell Alex's agent we don't need versioning yet — single version v1, no header.`
5. Skill calls `peer_human_inject(tag="HUMAN-BOB", text=...)`. Alex sees `[HUMAN-BOB]: we don't need versioning yet...` on his side; his agent treats it as overriding.
6. Bob's skill resumes its `peer_recv` loop.

---

## 9. Context preservation

### How it works

Every `peer_recv` and `peer_send` is a real tool call in the active Claude Code session's JSONL. The contents (Alex's words, Bob's replies) live in tool inputs/outputs. After the call ends:

- Bob asks: "what did Alex push back on regarding the timestamp?" → Claude reads back the relevant `peer_recv` from earlier in this same session, just like any prior tool result.
- Bob asks: "summarize the agreement" → Claude looks at the final `peer_end` tool input or the `agreement.md` artifact (which the skill always reads on close and prints as its final output).
- No `/clear`, no fork, no special "post-call mode."

### Token economy

A 50-turn call is non-trivial volume. Mitigations:

- The skill's final output is always a **structured summary block** (agreement + action items) — the cheap thing to reference later.
- `/compact focus on the peer call agreement` keeps the summary and drops the verbose back-and-forth when context fills.
- Artifacts persisted to disk (`~/.claude/peerd/calls/<id>/`) — full call survives session compaction. `/action-items <call-id>` re-imports them on demand.
- For very long calls, `peerd` can emit a checkpoint summary every N turns and push it into the live session via a synthetic tool result.

---

## 10. Intervention model (no web UI)

Both sides watch the call in their own Claude Code terminal naturally — `peer_recv` returning prints the incoming message; `peer_send` shows what the local agent emitted.

**Esc-yield mechanic.** Pressing Esc cancels the in-flight `peer_recv` (or `peer_send`). The skill traps the cancellation and presents a yield prompt:

```
─── YIELD ────────────────────────────────────────────────
Type a note to inject as you, /resume to release with no
note, /end to hang up, or /takeover to drive the rest of
the call yourself.
─────────────────────────────────────────────────────────
```

**`/takeover`** is the nuclear option: the skill exits, the agent stops auto-replying, and the human types each subsequent message directly. The peer side sees `[HUMAN-BOB-TAKEOVER]` and is instructed to treat the conversation as human-driven going forward.

**Status line.** A custom Claude Code status line component shows `📞 @alex · 02:14 · 23 turns · last msg 5s ago` while a call is active.

---

## 11. Call modes

Calls aren't only Q&A. Four supported patterns:

1. **Pure negotiation.** `peer_send` ↔ `peer_recv` until `peer_end` with an agreement. Best for contracts, design alignment.
2. **Show-and-tell.** `peer_share_file` interleaved with discussion. Best for "here's what I built; look it over."
3. **In-call edits.** One agent calls `peer_propose_change` with a diff; the other reviews and applies (with human gate) or counters. Best for surgical fixes (rename a field, change a return type).
4. **Handoff and reconvene** (recommended for substantive work). Call produces `action_items`; both sides hang up, each developer's Claude Code does the work locally, then one initiates a follow-up call (`/call alex re: yesterday's API changes — ready to verify`).

**Heuristic:** if the work needs ≥3 files changed, prefer handoff. In-call edits are for one-or-two-file clarifications. Calls are for alignment, not implementation.

---

## 12. Artifacts

Every call produces zero or more durable artifacts written to `~/.claude/peerd/calls/<id>/artifacts/`.

### `agreement.md`

```markdown
---
call_id: c_01H...
participants: [alex, bob]
topic: "User schema sync"
date: 2026-05-23T14:11:00Z
---

# Agreement

- User schema: `{ id: ULID, email: string, created_ts: RFC3339 }`
- Endpoint: `POST /users` returns 201 + Location header
- Errors: validation -> 422 with `{field, code, msg}`
```

### `action_items.md`

```markdown
---
call_id: c_01H...
---

- [ ] @bob — implement User emitter using agreed schema (due: 2026-05-25)
- [ ] @alex — tighten ingest validator to require RFC3339 (due: 2026-05-25)
- [ ] @bob — open PR and `/call alex` for verification
```

### `interfaces/<name>.md`

For interface artifacts created via `peer_propose_interface` (a typed-contract specialization of `peer_share_file`). Schema in TS / JSON Schema / Protobuf — whatever the team standardizes on.

Artifacts are **idempotent**: re-running a call on the same topic updates the file; older versions retained as `.bak`.

---

## 13. Failure modes & recovery

| Failure | Behavior |
|---|---|
| Peer Mac sleeps mid-call | WSS drops; local skill's `peer_recv` returns `PEER_DISCONNECTED` after 30s; agent gets `{kind: "disconnect", will_retry: true}`; skill retries reconnect for 5 min, then ends with status `dropped`. |
| Network blip | WS reconnects with `Last-Seq`; buffered messages replayed; user sees no interruption. |
| `peerd` crashes | LaunchAgent restarts it within seconds; in-flight call state reloaded from `calls/<id>/transcript.jsonl`; skill reconnects to local socket. |
| Claude Code crashes mid-call | `peer-mcp` dies; `peerd` notifies peer with `disconnect`; peer can choose to wait (callee may reopen Claude Code and `/resume-call <id>`) or end. |
| Both sides try to `peer_send` simultaneously | Strict turn-lock in `peerd`; second sender gets `OUT_OF_TURN`; agent re-receives instead. |
| Invite to offline peer | After 60s without TCP connect or `invite_response`, returns `PEER_UNREACHABLE`; caller's agent offered voicemail. |
| Token mismatch / replay | Reject with `AUTH_FAILED`; log to `peerd.log`. |

---

## 14. Security

- **Tailscale ACLs** are the primary access control. Restrict peer port to teammates' nodes.
- **Bearer tokens** per peer; rotate quarterly. Stored only in `~/.claude/peerd/peers.toml` (mode 600).
- **Per-call session tokens** prevent replay or hijack within an active call.
- **TLS** with pinned self-signed certs; rejects unknown certs.
- **No code execution from peer messages.** `peer_propose_change` produces a diff that the receiver's *agent* may choose to apply via its own `Edit` tool, subject to Claude Code's normal permission prompts. There is no auto-apply path.
- **Audit log** of every call (`peerd.log`): peer, topic, duration, artifacts produced. No message content unless `--verbose-audit` flag is on (off by default).

---

## 15. Open questions

1. **Voicemail length.** A queued message is a one-shot text — but for long async context, should we allow file attachments? Probably yes, with size cap.
2. **Group calls (3+).** Out of scope for v1, but the protocol's `call_id` + `from` fields are designed to extend. Adding broadcast would mean changing turn-lock semantics (round-robin? moderator?).
3. **Cross-agent observability.** Should a third party (team lead) be able to passive-monitor a call? Doable by adding a `peer_observe` role that gets a read-only WS feed, but it complicates trust. Defer.
4. **Conflict resolution for `propose_change`.** If both sides propose conflicting changes to the same file in their own repos during a call, we don't automate the merge. Humans decide.
5. **Persistence across reboots.** Calls in `PAUSED` state — how long do we keep them resumable? Suggest 24h default.
6. **Compaction-aware summaries.** Should `peerd` proactively inject a "summary so far" tool result every N turns to keep token cost down? Trade-off: clutter vs. context safety.

---

## 16. Implementation milestones

### M1 — Round-trip proof (1 week)

- `peerd` with WSS listener, mDNS, fixed bearer token, no auth-token rotation.
- `peer-mcp` exposing only `peer_invite`, `peer_recv`, `peer_send`, `peer_end`.
- No skills, no Stop hook — invoke MCP tools directly from a test Claude Code session.
- Goal: two agents exchange 10 messages over Tailscale and end cleanly.

### M2 — Real UX (1 week)

- Stop hook + `peer-check-inbox` script.
- `/accept`, `/deny`, `/call`, `/end-call` skills.
- macOS notification on incoming invite.
- Status line component.

### M3 — Call modes (1 week)

- `peer_share_file`, `peer_propose_change`, `peer_fetch`.
- `peer_pause` / `peer_resume`.
- Per-call session token issuance.

### M4 — Artifacts + voicemail (1 week)

- Structured `peer_end` writes `agreement.md` + `action_items.md`.
- `/action-items` skill.
- Voicemail flow (`peer_voicemail`, `/vmail`).

### M5 — Polish (ongoing)

- Reconnect / replay.
- Audit log.
- Token rotation.
- Docs + onboarding script.

Total: ~4 weeks for a usable v1; M1+M2 alone (~2 weeks) is the minimum to validate the UX.

---

## Appendix A — File layout

```
~/.claude/
  settings.json                    # Stop hook config
  mcp.json                         # peer-mcp registration
  skills/
    accept/SKILL.md
    deny/SKILL.md
    call/SKILL.md
    end-call/SKILL.md
    action-items/SKILL.md
    vmail/SKILL.md
  peerd/
    peers.toml                     # peer directory + tokens
    control.sock                   # peer-mcp ↔ peerd RPC
    peerd.log
    inbox/
      <session-id>.json            # pending invites for that session
    calls/
      <call-id>/
        transcript.jsonl
        artifacts/
          agreement.md
          action_items.md
          interfaces/<name>.md
        meta.json                  # state, participants, timestamps
    voicemail/
      <vm-id>.json
```

## Appendix B — Minimal `peers.toml` example

```toml
self = "bob"

[peers.alex]
host    = "alex-macbook.tailnet-name.ts.net"
port    = 7777
token   = "sk_peer_..."          # outgoing bearer
fingerprint = "sha256/..."        # TLS cert pin

[peers.charlie]
host    = "100.64.0.12"
port    = 7777
token   = "sk_peer_..."
fingerprint = "sha256/..."
```

## Appendix C — Stop-hook output contract

`peer-check-inbox` prints to stdout, exit code 0:

```
📞 Incoming peer call from <peer>@<their-session-label>
   Topic: "<topic>"
   Sent: <relative-time> ago
   /accept · /deny · /vmail
```

Or, if no pending invite, prints nothing and exits 0. The hook returns an `additionalContext` block only if stdout is non-empty.

---

*End of document.*
