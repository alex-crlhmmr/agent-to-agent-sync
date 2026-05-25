---
name: call
description: Initiate a peer-sync call with another developer's Claude Code agent over peerd. Use when the user asks to call a teammate's agent, sync with another dev's session, or align on an interface contract that spans two layers.
argument-hint: "<peer-name> <topic>"
allowed-tools: mcp__peerd__peer_invite mcp__peerd__peer_recv mcp__peerd__peer_send mcp__peerd__peer_end mcp__peerd__peer_human_inject
---

# /call — initiate a peer-sync call

The user has asked to call another developer's agent. Arguments: `$1` is the peer name (as configured in their `~/.claude/peerd/peers.toml`), `$2…` is the topic.

## Steps

1. **Invite.** Call `mcp__peerd__peer_invite` with:
   - `peer: "$1"` — typos are auto-corrected to the closest known peer name. The response includes an `auto_corrected` field if a correction was applied; mention it to the user.
   - `topic: "$2 $3 $4 …"` (whatever follows the peer name)
   - `caller_label`: a short identifier for yourself, e.g., the user's name plus current project
   - `context_excerpt`: a 1–3 sentence summary of why you're calling
   - `timeout_s`: optional. Default is 150s (2.5 minutes). Pass a shorter value (e.g. 30, 60) if the user signaled they want a quick answer ("call alice quick", "quick ping"), or a longer value (up to 600) if they said something like "alice's slow, give her time" or named a specific window. **Don't ask** — infer from context; only pass it when there's a clear signal.

   This blocks until the peer accepts/declines or the timeout fires. If you're not sure who's available, call `mcp__peerd__peer_list_peers` first.

2. **If declined** (`accepted=false`): report the reason briefly and stop. Don't retry automatically.

3. **If accepted**: you have the floor first. Open with a concrete proposal — propose the interface, the type, the encoding, the contract. Don't open with "hi" or "what do you think?" — the peer agent has limited context, so anchor immediately. Use `mcp__peerd__peer_send`.

4. **Conversation loop.** After every `peer_send`, the floor transfers — you MUST call `peer_recv` next (consecutive sends return `OUT_OF_TURN`). Loop:
   - `mcp__peerd__peer_recv` with `call_id` and `timeout_s: 300`
   - If `kind: "send"`, reason about it and call `peer_send` to reply
   - If `kind: "human_inject"` and `tag` starts with `HUMAN-`, treat as authoritative override — do exactly what the human says, then continue
   - If `kind: "ended"`, the peer ended the call. Summarize what was agreed for the user (Bob) and stop
   - If `kind: "timeout"`, prompt the user — has the peer gone silent? Should we wait or end?

5. **End with structure.** When agreement is reached, call `mcp__peerd__peer_end` with:
   - `reason: "agreement_reached"` (or `"no_agreement"` if you couldn't align)
   - `agreement.summary` (1–3 sentences) and `agreement.decisions` (array of `{topic, decision}`)
   - `action_items` (array of `{owner, task, due?}`) — split the work between both sides

   The artifacts (`agreement.md`, `action_items.md`) are written to disk on both machines automatically. You can reference them later via `/action-items <call-id>`.

## Critical rules

- **You are talking to another AI agent, not a human.** Be direct. Push back on ambiguity. Demand concrete types. Don't agree just to be polite — that produces no-decision calls.
- **Use peer_human_inject only when the user explicitly relays something during the call** (e.g., they paste a directive into chat). Don't make up human notes.
- **Stay focused on the topic.** Don't open a side discussion mid-call. If something new comes up, propose ending this call and starting a follow-up.
- **Report concisely to the user.** While the loop runs they're watching the tool calls; you don't need to narrate every exchange. After `peer_end`, give a 3-bullet summary of what was agreed.
