# peerd — Wire & Local Protocol Specification

**Version:** v1 draft • **Status:** specification • **Companion doc:** `ARCHITECTURE.md`

This document specifies two protocols:

1. **Wire protocol** — between two `peerd` instances on different machines, over WebSocket Secure (WSS).
2. **Local protocol** — between an agent integration shim (e.g., `peer-mcp` for Claude Code, a hypothetical `peer-codex` for Codex, or a `peer-cli` for any shell-driving agent) and the local `peerd`, over a Unix domain socket.

The two protocols are deliberately separable. `peerd` and the wire format are **agent-agnostic**; only the integration shim is harness-specific.

---

## 1. Layering

```
                                      ┌──────────────────────────────┐
   Agent (Claude / Codex / Cursor /…) │  Per-harness invocation API  │
                                      └─────────────┬────────────────┘
                                                    │ (MCP / plugin / CLI)
                                      ┌─────────────▼────────────────┐
                                      │  Integration shim            │
   ────────────────────────────────── │  (peer-mcp, peer-codex, …)   │  layer
   ★ LOCAL PROTOCOL ★                 │  Translates harness calls    │  boundary
                                      │  into local RPC.             │
                                      └─────────────┬────────────────┘
                                                    │ Unix domain socket
                                                    │  ~/.claude/peerd/control.sock
                                      ┌─────────────▼────────────────┐
                                      │  peerd (this machine)        │
                                      │  Authoritative call state,   │
                                      │  durable storage, network.   │
                                      └─────────────┬────────────────┘
                                                    │
   ────────────────────────────────── ★ WIRE PROTOCOL ★              layer boundary
                                                    │ WSS, port 7777
                                      ┌─────────────▼────────────────┐
                                      │  peerd (peer machine)        │
                                      └──────────────────────────────┘
```

A conformant `peerd` implements the wire protocol exactly. Conformant integration shims implement the local protocol. Anything above the shim is implementation-defined.

---

## 2. Common conventions

- **Encoding:** UTF-8 JSON, line-delimited on Unix sockets (`\n`-terminated), text frames on WSS.
- **Timestamps:** RFC 3339 UTC with millisecond precision (`2026-05-23T14:02:11.421Z`).
- **IDs:** ULIDs (26-character Crockford base32, sortable, URL-safe). Prefixed by domain:
  - Call IDs: `c_01HZX9Y…`
  - Voicemail IDs: `vm_01HZX9Y…`
  - Artifact IDs: `art_01HZX9Y…`
- **Sequence numbers:** unsigned 64-bit, monotonic per `(call_id, direction)`. Each side increments its own counter.
- **Strings:** no implicit length limit, but conformant `peerd` MAY reject messages larger than 1 MiB total frame size with `MESSAGE_TOO_LARGE`. Use `share_file_ref` (§5.5.2) for larger payloads.
- **Reserved fields:** any field name starting with `x-` is implementation-defined and MUST be tolerated (ignored if unknown) by receivers.
- **Forward compatibility:** receivers MUST ignore unknown top-level fields and unknown enum values where this spec does not say otherwise.

---

## 3. Wire protocol — `peerd` ↔ `peerd`

### 3.1 Transport

- WebSocket Secure (TLS 1.2+), port `7777` by default.
- Subprotocol: `peerd.v1`.
- TLS: self-signed certificate, pinned by fingerprint (`sha256/...`) listed in the caller's `peers.toml`. Servers MAY also pin the client cert if mutual TLS is desired (out of scope for v1).
- Heartbeat: ping every 15 s, idle-timeout at 60 s without pong.

### 3.2 Authentication

On WSS upgrade, the caller MUST send these HTTP headers:

```
X-Peerd-Version: 1
X-Peerd-From: alex                      # local peerd's "self" name
X-Peerd-Token: sk_peer_<opaque>         # long-lived bearer for this peer
```

The receiver looks up `X-Peerd-From` in its local `peers.toml`, validates that the presented token matches the recorded incoming token for that peer, and accepts or rejects with HTTP 401 + `WWW-Authenticate: Peerd error="AUTH_FAILED"`.

After connection upgrade, **the first message MUST be a `HELLO`** (§5.1). Failure to send `HELLO` within 5 s closes the connection with WS code 1008 (policy violation).

### 3.3 Message envelope

Every wire message is a JSON object with this envelope:

```json
{
  "v": 1,
  "type": "<message-type>",
  "ts": "2026-05-23T14:02:11.421Z",
  "from": "alex",
  "call_id": "c_01HZX9Y...",     // present on all in-call messages
  "seq": 42,                     // monotonic per (call_id, from)
  "payload": { ... }             // type-specific
}
```

`call_id` and `seq` are omitted on session-level messages (`HELLO`, `WELCOME`, `PING`, `PONG`, `DISCONNECT`). They are required on every call-level message. A message with `call_id` referencing an unknown or closed call MUST be rejected with `ERROR{code: UNKNOWN_CALL or CALL_CLOSED}`.

### 3.4 Reconnect & replay

On unexpected disconnect, both sides MAY reconnect within 60 s. After a fresh `HELLO`, either side MAY send:

```json
{ "type": "RESUME", "payload": { "call_id": "c_01...", "last_seq_received": 41 } }
```

The peer replays all messages with `seq > last_seq_received` from its outbound buffer (kept for ≥ 60 s), then resumes normal operation. After 60 s, buffers are dropped and resume returns `ERROR{code: RESUME_EXPIRED}`; the agent must restart the call.

### 3.5 Turn discipline

For any call in `CONNECTED` state, only one side has "the floor" at a time. The side with the floor MAY send any of:

- `SEND` · `SHARE_FILE` · `SHARE_FILE_REF` · `PROPOSE_CHANGE`

After sending one of these, the floor transfers to the peer. The peer's next floor-transfer message (one of the same set, or `PAUSE`/`END`) returns the floor.

Either side, at any time and regardless of floor, MAY send:

- `HUMAN_INJECT` · `PAUSE` · `RESUME` · `FETCH` · `FETCH_RESPONSE` · `END` · `ERROR` · `PING` · `PONG`

Out-of-turn floor-messages MUST be rejected with `ERROR{code: OUT_OF_TURN}` and not applied.

The initial floor belongs to the **caller** (the side that sent `INVITE`), unless `INVITE.payload.first_floor = "callee"` is set.

---

## 4. Call state machine

```
                           ┌─────────┐
                           │  IDLE   │
                           └────┬────┘
                                │  send INVITE
                                ▼
                           ┌─────────┐
                           │ DIALING │
                           └────┬────┘
                  accept=false  │  accept=true
              ┌─────────────────┼────────────────┐
              ▼                 │                ▼
        ┌─────────┐             │           ┌──────────┐
        │ CLOSED  │             │           │CONNECTED │
        └─────────┘             │           └────┬─────┘
                                │                │
                                │       ┌────────┼────────┐
                                │       │        │        │
                                │   PAUSE        │      END/timeout
                                │       │        │        │
                                │       ▼        │        ▼
                                │   ┌─────────┐  │   ┌─────────┐
                                │   │ PAUSED  │  │   │ CLOSING │
                                │   └────┬────┘  │   └────┬────┘
                                │        │ RESUME│        │ artifacts persisted
                                │        └───────┘        ▼
                                │                    ┌─────────┐
                                │                    │ CLOSED  │
                                │                    └─────────┘

Mirror on callee side:
  IDLE → (recv INVITE) → RINGING → (accept) CONNECTED  /  (decline) CLOSED
```

`peerd` is the authority on state. State is persisted to `~/.claude/peerd/calls/<call-id>/meta.json` after every transition.

A call in `CONNECTED` or `PAUSED` with no traffic for 30 minutes auto-transitions to `CLOSING` with reason `idle_timeout`.

---

## 5. Wire message types

Each subsection gives the `payload` schema. Required fields are marked `*`.

### 5.1 `HELLO` (session-level)

Sent immediately after WSS upgrade.

```json
{
  "*peer_version": "0.3.1",
  "*capabilities": ["share_file", "propose_change", "voicemail", "fetch"],
  "advertised_name": "alex-macbook",
  "supported_protocol_versions": [1]
}
```

### 5.2 `WELCOME` (session-level)

Server's reply to `HELLO`.

```json
{
  "*peer_version": "0.3.1",
  "*capabilities": ["share_file", "propose_change", "voicemail", "fetch"],
  "*protocol_version": 1,
  "*server_time": "2026-05-23T14:02:11.421Z"
}
```

The intersection of `HELLO.capabilities` and `WELCOME.capabilities` is the agreed capability set for the session.

### 5.3 `PING` / `PONG` (session-level)

```json
{ "nonce": "01H..." }
```

`PONG.payload.nonce` MUST equal the triggering `PING.payload.nonce`.

### 5.4 `INVITE`

Initiates a call.

```json
{
  "*topic": "User schema sync",
  "*caller_label": "alex@layer-a-dev",
  "expires_at": "2026-05-23T14:03:11.421Z",     // default: ts + 60s
  "first_floor": "caller",                        // or "callee", default "caller"
  "suggested_artifacts": ["interfaces/User"],
  "context_excerpt": "..."                        // optional; up to 8 KiB
}
```

`call_id` in the envelope is generated by the caller and is the canonical ID.

### 5.5 `INVITE_RESPONSE`

Reply to `INVITE`.

```json
{
  "*accepted": true,
  "reason": "...",                  // required if accepted=false
  "session_token": "sk_call_..."    // required if accepted=true
}
```

The `session_token` is generated by the callee and MUST be presented by the caller on any reconnect for this call. Treated as opaque.

### 5.5.1 `SEND`

```json
{ "*text": "I'm planning to emit User{id: ULID, email, ts}. OK?" }
```

### 5.5.2 `SHARE_FILE`

Inline file share (small files, ≤ 256 KiB).

```json
{
  "*path": "schemas/user.ts",
  "*content": "...",
  "language": "typescript",
  "reason": "here's the type I'd ship",
  "hash_sha256": "..."
}
```

### 5.5.3 `SHARE_FILE_REF`

Reference-only share (large files). The receiver MAY call `FETCH` to retrieve the body.

```json
{
  "*ref": "ref_01HZX...",
  "*path": "src/ingest/validator.go",
  "*size_bytes": 412938,
  "*hash_sha256": "...",
  "preview": "func ValidateUser(u *User) error { ... }",
  "preview_lines": "1-40",
  "reason": "the full validator if you want to read it"
}
```

### 5.5.4 `PROPOSE_CHANGE`

Cross-side diff proposal — "I propose this change on YOUR side."

```json
{
  "*target_file": "schemas/user.ts",
  "*diff": "@@ -3,1 +3,1 @@\n- ts: number\n+ ts: string  // RFC3339\n",
  "*rationale": "Our parser is strict, expects RFC3339",
  "requires_human_approval": true,        // default true
  "tests_added": []                       // optional list of related test diffs
}
```

The recipient's agent MAY apply this diff to its local repo via its own editor tool. `peerd` does NOT apply diffs; that's strictly the agent's job, gated by the harness's normal permission flow.

### 5.5.5 `PAUSE`

```json
{
  "*reason": "running tests locally",
  "eta_seconds": 180
}
```

### 5.5.6 `RESUME`

```json
{}
```

Only valid from the side that issued the preceding `PAUSE`.

### 5.5.7 `HUMAN_INJECT`

Out-of-band human note, valid from either side at any time.

```json
{
  "*tag": "HUMAN-BOB",
  "*text": "Tell Alex we don't need versioning yet.",
  "priority": "override"               // "override" | "advisory", default "advisory"
}
```

Implementations SHOULD surface `priority=override` notes to the receiving agent with explicit "this overrides anything I said" framing.

### 5.5.8 `END`

Graceful call close with structured summary.

```json
{
  "*reason": "agreement_reached",     // or "human_takeover" | "no_agreement" | "timeout" | "error"
  "agreement": {                       // optional, structured agreement payload
    "summary": "...",
    "decisions": [
      { "topic": "User.ts field", "decision": "RFC3339 string" }
    ]
  },
  "action_items": [
    { "owner": "bob", "task": "implement User emitter", "due": "2026-05-25" }
  ],
  "artifacts": [
    { "kind": "agreement", "path": "calls/<id>/artifacts/agreement.md" }
  ]
}
```

After `END` is exchanged in both directions (or after a 10 s wait), both `peerd`s persist artifacts and transition the call to `CLOSED`.

### 5.5.9 `FETCH`

Request the body of a previously shared `SHARE_FILE_REF`.

```json
{ "*ref": "ref_01HZX..." }
```

### 5.5.10 `FETCH_RESPONSE`

```json
{
  "*ref": "ref_01HZX...",
  "*content": "...",
  "*hash_sha256": "..."
}
```

The provider MUST verify the hash matches what it advertised in `SHARE_FILE_REF`. If a fetch is denied (e.g., file deleted, access revoked), respond with `ERROR{code: REF_UNAVAILABLE}` referencing the original `seq`.

### 5.5.11 `VOICEMAIL`

Async message left when the callee was offline or busy. Sent OUTSIDE a call context — `call_id` and `seq` are omitted; instead, payload carries a `vm_id`.

```json
{
  "*vm_id": "vm_01HZX...",
  "*topic": "re: User schema timestamp mismatch",
  "*text": "Flagged a type mismatch — RFC3339 not unix. LMK when free.",
  "expires_at": "2026-05-30T14:02:11.421Z"
}
```

### 5.5.12 `DISCONNECT` (session-level)

Graceful close.

```json
{ "reason": "shutting down" }
```

Followed by WS close frame.

### 5.5.13 `ERROR`

```json
{
  "*code": "OUT_OF_TURN",
  "*message": "Floor is held by peer",
  "in_response_to_seq": 41,            // optional
  "in_response_to_call": "c_01H...",   // optional
  "details": {}                         // optional, code-specific
}
```

---

## 6. Error code registry

| Code | Meaning |
|---|---|
| `AUTH_FAILED` | Token rejected at WSS upgrade or per-call. |
| `UNSUPPORTED_VERSION` | No common protocol version. |
| `UNKNOWN_PEER` | `from` value not in receiver's `peers.toml`. |
| `INVALID_MESSAGE` | Malformed JSON or missing required field. |
| `MESSAGE_TOO_LARGE` | Exceeds 1 MiB frame size. |
| `UNKNOWN_CALL` | `call_id` not recognized. |
| `CALL_CLOSED` | `call_id` is in `CLOSED` state. |
| `OUT_OF_TURN` | Floor-transfer message sent by wrong side. |
| `INVITE_TIMEOUT` | Invite expired without `INVITE_RESPONSE`. |
| `INVITE_DECLINED` | Surfaced to caller; not an error per se, but uses ERROR frame for uniform handling. |
| `PEER_UNREACHABLE` | TCP/TLS connect failed. |
| `RESUME_EXPIRED` | Reconnect attempted after buffer drop. |
| `REF_UNAVAILABLE` | `SHARE_FILE_REF` referenced by `FETCH` no longer fetchable. |
| `RATE_LIMITED` | Implementation-defined; receiver MAY reject if peer is sending too fast. |
| `INTERNAL_ERROR` | Catch-all; details SHOULD be logged. |

All codes are stable strings. New codes MUST be added with a spec update; receivers MUST treat unknown codes as `INTERNAL_ERROR`-equivalent.

---

## 7. Canonical sequence diagrams

### 7.1 Successful call

```
caller(peerd)                      callee(peerd)
   │                                    │
   │── WSS upgrade + token ──────────►  │
   │◄─── 101 Switching ────────────────│
   │── HELLO ────────────────────────►  │
   │◄─── WELCOME ──────────────────────│
   │                                    │
   │── INVITE{call_id=c1, topic=…} ─►  │  (rings callee; Stop hook surfaces)
   │                                    │
   │                                    │  (callee /accept)
   │◄─ INVITE_RESPONSE{accepted=true,  │
   │   session_token=…} ───────────────│
   │                                    │
   │ === CONNECTED, floor=caller ====   │
   │── SEND{"I'll emit User{…}"} ───►  │  floor→callee
   │◄── SEND{"ts as RFC3339"} ─────────│  floor→caller
   │── SHARE_FILE{schemas/user.ts} ─►  │  floor→callee
   │◄── PROPOSE_CHANGE{user.ts} ───────│  floor→caller
   │── SEND{"accepted, applying"} ──►  │  floor→callee
   │◄── END{reason=agreement_reached, │
   │       action_items=[…]} ─────────│
   │── END{reason=agreement_reached}─► │
   │                                    │
   │ === CLOSED ====================    │
```

### 7.2 Voicemail flow

```
caller(peerd)                      callee(peerd)
   │── INVITE ──────────────────────►  │  (callee busy; no /accept fires)
   │                                    │
   │ (60s expires_at hits)              │
   │   local: INVITE_TIMEOUT            │
   │                                    │
   │── VOICEMAIL{vm_id, topic, text} ► │  (queued to inbox)
   │◄── ack via TCP only ───────────── │
   │── DISCONNECT ───────────────────► │
```

### 7.3 Mid-call intervention (HUMAN_INJECT)

```
caller(peerd)                      callee(peerd)
   │ === CONNECTED, floor=callee =====
   │                                    │  (callee thinking/typing reply)
   │                                    │
   │   (caller's human hits Esc on
   │    their side, types a note)       │
   │                                    │
   │── HUMAN_INJECT{tag=HUMAN-ALEX,   │
   │   text="no versioning yet"} ───► │
   │                                    │  (callee surfaces override to agent)
   │                                    │
   │◄── SEND{"got it, dropping ver"} ─│  floor→caller
```

---

## 8. Local protocol — shim ↔ `peerd`

### 8.1 Transport

- Unix domain socket at `~/.claude/peerd/control.sock`.
- Line-delimited JSON. One request per line, one response per line.
- Mode `0600`, owned by the user.

### 8.2 Request envelope

```json
{ "id": 17, "method": "send", "params": { ... } }
```

`id` is a client-chosen integer; responses echo it. Methods that produce streaming output (`recv`, `subscribe_inbox`) emit multiple lines, each a "notification" matching `id`, terminated by a final response.

### 8.3 Response envelope

Success:

```json
{ "id": 17, "result": { ... } }
```

Error:

```json
{ "id": 17, "error": { "code": "OUT_OF_TURN", "message": "...", "details": {} } }
```

Error codes mirror §6 plus shim-local additions (`NO_ACTIVE_CALL`, `INVALID_PARAMS`, etc.).

### 8.4 Methods

#### Connection / inventory

- `list_peers` → `{ peers: [{name, host, port, last_seen}] }`
- `list_calls` → `{ calls: [{call_id, peer, topic, state, started_at}] }`
- `list_inbox` → `{ invites: [...], voicemails: [...] }`
- `subscribe_inbox` → streams inbox notifications until cancelled (used by the Stop hook script's daemon-mode option; in v1 the script just polls `list_inbox` each time it fires)

#### Call lifecycle

- `invite(peer, topic, capabilities?, suggested_artifacts?)` → `{ call_id, accepted, reason?, session_token? }` *(blocks until `INVITE_RESPONSE` or timeout)*
- `accept_invite(call_id)` → `{ session_token }`
- `deny_invite(call_id, reason?)` → `{ ok: true }`
- `end(call_id, agreement?, action_items?)` → `{ artifacts: [...] }`

#### Content (turn-locked; `peerd` rejects out-of-turn)

- `send(call_id, text)` → `{ seq }`
- `share_file(call_id, path, content?, mode = "inline"|"ref", reason?)` → `{ seq, ref? }`
- `propose_change(call_id, file, diff, rationale, requires_human_approval = true)` → `{ seq }`
- `pause(call_id, reason, eta_seconds?)` → `{ ok }`
- `resume(call_id)` → `{ ok }`

#### Receive

- `recv(call_id, timeout_s)` → blocks for up to `timeout_s` seconds; returns `{ kind, seq, from, payload }` for the next message, or `{ kind: "timeout" }`.
- `fetch(call_id, ref)` → `{ content, hash_sha256 }`

#### Side channels

- `human_inject(call_id, tag, text, priority?)` → `{ seq }`
- `voicemail_send(peer, topic, text)` → `{ vm_id }`
- `voicemail_read(vm_id)` → full voicemail payload; marks as read
- `status(call_id?)` → `{ call_state, peer_present, last_msg_age_s, pending_human_notes, floor }`

### 8.5 Notification frames (server-initiated)

`peerd` MAY push unsolicited notifications on a subscribe stream. Each is:

```json
{ "id": <subscribe-id>, "notification": { "kind": "invite", "payload": {...} } }
```

Kinds: `invite`, `voicemail`, `peer_online`, `peer_offline`, `call_ended`. Notifications never block the caller; they exist only on streams the shim explicitly subscribes to.

---

## 9. Capability negotiation

Capabilities are advertised in `HELLO`/`WELCOME`. A capability the local side has but the peer doesn't MUST NOT be used. v1 defines:

- `share_file` — `SHARE_FILE` and `SHARE_FILE_REF`
- `propose_change` — `PROPOSE_CHANGE`
- `voicemail` — `VOICEMAIL` outside calls
- `fetch` — `FETCH`/`FETCH_RESPONSE`
- `pause_resume` — `PAUSE`/`RESUME`
- `human_inject` — `HUMAN_INJECT`

A minimal v1 implementation MUST support: `SEND`, `END`, `HUMAN_INJECT`. Everything else is optional but recommended.

Future capabilities will use a `peerd.cap.` prefix (e.g., `peerd.cap.multi_party`) to avoid collisions.

---

## 10. Integration shim guide

To make `peerd` work with a new agent harness (Codex, Cursor, Aider, custom in-house agent, etc.), implement a shim that:

1. **Connects** to `~/.claude/peerd/control.sock` via Unix socket.
2. **Exposes tools/commands** to the agent that map 1:1 to local protocol methods. Naming convention `peer_<method>` recommended.
3. **Long-poll on `recv`**: implement the receive loop in whatever shape the harness allows. For MCP-supporting harnesses, expose `peer_recv` as a tool that returns when a message arrives or after timeout. For CLI-only harnesses (`peer-cli`), provide a blocking subcommand `peer-cli recv --call <id> --timeout 300`.
4. **Surface invites at idle.** If the harness has a "session idle" hook (like Claude Code's Stop hook), trigger an inbox check there. If not, an alternative pattern is to expose a `peer_check_inbox` tool the agent calls periodically — slightly worse UX but works in any harness.
5. **Pass through HUMAN_INJECT priority.** When the agent receives a message with `tag` prefix `HUMAN-`, ensure the harness's prompt presents it with override framing.
6. **Persist call ID** for the active session so multiple turns can refer to the same call without re-passing the ID on every call.

A complete reference shim (`peer-mcp`, ~600 LOC TypeScript) lives in the same repo and may be used as a template.

### 10.1 Minimum viable shim

Even without any harness extension API, a CLI-only integration is possible:

```
$ peer-cli call alex "User schema sync"
[invite sent; waiting for accept]
[accepted, call_id=c_01HZX...]
> (agent types message)
$ peer-cli send c_01HZX... "I'll emit User{…}"
$ peer-cli recv c_01HZX... --timeout 300
{"kind":"send","text":"ts as RFC3339..."}
...
$ peer-cli end c_01HZX... --agreement-file ./agreement.md
```

Any agent harness that can run shell commands and read their stdout can drive this. The UX is rougher (no auto-idle banner; the user manually invokes `peer-cli recv`), but functionally complete.

---

## 11. Conformance test vectors

A reference suite ships with `peerd` (`peerd test-vectors`) and exercises:

### 11.1 Frame round-trip

For each message type in §5, the test vectors include a canonical JSON encoding. Implementations MUST encode/decode bit-for-bit equivalent.

### 11.2 Turn discipline

Scripted scenarios that send out-of-turn messages and assert `OUT_OF_TURN` is returned.

### 11.3 Reconnect & replay

Drop the WSS after `seq=10` mid-call; reconnect within 60 s with `RESUME{last_seq_received: 8}`. MUST replay messages 9 and 10.

### 11.4 Capability gating

Peer advertises only `[]` (minimum). Caller MUST NOT send `SHARE_FILE`. If it does, receiver returns `ERROR{code: INVALID_MESSAGE, details: {reason: "capability not negotiated"}}`.

### 11.5 Voicemail expiration

`VOICEMAIL` with `expires_at` in the past MUST be silently dropped by the receiver (not surfaced to the agent), and the sender MUST receive no error.

### 11.6 Auth replay

Re-presenting a per-call `session_token` after `END` MUST be rejected with `CALL_CLOSED`.

---

## 12. Reserved & future extensions

The following are reserved for future versions and MUST NOT be sent by v1 implementations:

- `MULTI_PARTY_INVITE` — for 3+ participant calls.
- `OBSERVE` / `OBSERVE_RESPONSE` — for read-only third-party monitoring.
- `RPC_CALL` / `RPC_RESPONSE` — for synchronous structured queries between agents (e.g., "what types are exported from your module?").
- `STREAM_OPEN` / `STREAM_CHUNK` / `STREAM_CLOSE` — for chunked transfer of very large artifacts.
- `BROADCAST` — for one-to-many announcements within a tailnet.

The reserved-field prefix `x-` is for implementation-specific experiments. Anything moved into v2 will get a non-prefixed name.

---

## 13. Versioning policy

- Protocol version is a single integer in `v` of the envelope and `protocol_version` of `WELCOME`.
- Implementations MUST list all supported versions in `HELLO.supported_protocol_versions`. The server picks the highest mutually supported and echoes it in `WELCOME.protocol_version`.
- v1 is the first stable version. v2 will be defined when a backward-incompatible change is needed; until then, all changes are additive (new optional fields, new message types behind capability flags).

---

## 14. Security notes

- **Trust boundary** is the bearer token in `peers.toml`. Treat token leakage as you would an SSH private key. Rotate quarterly.
- **TLS pinning** is mandatory. Implementations MUST NOT fall back to system CA validation; the only trusted certs are those whose `sha256` fingerprint is listed in `peers.toml`.
- **Diffs from `PROPOSE_CHANGE`** are data, not code. `peerd` MUST NOT execute or apply them. Applying is the agent's responsibility, subject to the harness's permission model.
- **File content from `SHARE_FILE`** is data, not code. Same rule.
- **Voicemails** are durable; expiration is best-effort cleanup, not a guarantee. Sensitive content should not be left as voicemail.

---

## Appendix A — Sample `HELLO`/`WELCOME` exchange

```json
// caller → callee
{ "v": 1, "type": "HELLO", "ts": "2026-05-23T14:02:11.421Z", "from": "alex",
  "payload": {
    "peer_version": "0.3.1",
    "capabilities": ["share_file", "propose_change", "voicemail", "fetch", "pause_resume", "human_inject"],
    "advertised_name": "alex-macbook",
    "supported_protocol_versions": [1]
  }
}

// callee → caller
{ "v": 1, "type": "WELCOME", "ts": "2026-05-23T14:02:11.430Z", "from": "bob",
  "payload": {
    "peer_version": "0.3.1",
    "capabilities": ["share_file", "voicemail", "human_inject"],
    "protocol_version": 1,
    "server_time": "2026-05-23T14:02:11.430Z"
  }
}

// Agreed capabilities for this session: ["share_file", "voicemail", "human_inject"]
```

## Appendix B — Sample invite + accept

```json
// caller → callee
{ "v": 1, "type": "INVITE",
  "ts": "2026-05-23T14:02:12.000Z",
  "from": "alex",
  "call_id": "c_01HZXABCDEFG",
  "seq": 1,
  "payload": {
    "topic": "User schema sync",
    "caller_label": "alex@layer-a-dev",
    "expires_at": "2026-05-23T14:03:12.000Z",
    "first_floor": "caller",
    "context_excerpt": "I need to define User and want to confirm field types/encodings with you."
  }
}

// callee → caller (after Bob types /accept)
{ "v": 1, "type": "INVITE_RESPONSE",
  "ts": "2026-05-23T14:02:24.112Z",
  "from": "bob",
  "call_id": "c_01HZXABCDEFG",
  "seq": 1,
  "payload": {
    "accepted": true,
    "session_token": "sk_call_01HZX..."
  }
}
```

## Appendix C — Sample `recv` long-poll on the local socket

```
→ {"id":4,"method":"recv","params":{"call_id":"c_01HZXABCDEFG","timeout_s":300}}
   [server holds the connection until peer sends a message or 300s elapse]
← {"id":4,"result":{"kind":"send","seq":3,"from":"bob","payload":{"text":"ts as RFC3339 string, not unix-ms"}}}
```

---

*End of document.*
