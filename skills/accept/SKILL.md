---
name: accept
description: Accept the most recent pending peer-call invite and conduct the conversation. Use when the Stop hook has surfaced a 📞 banner showing an incoming call, or when the user explicitly says to accept a call.
allowed-tools: mcp__peerd__peer_list_inbox mcp__peerd__peer_accept_invite mcp__peerd__peer_recv mcp__peerd__peer_send mcp__peerd__peer_end mcp__peerd__peer_human_inject
---

# /accept — accept the incoming peer call

## Steps

1. **Find the invite.** Call `mcp__peerd__peer_list_inbox`. If `invites` is empty, tell the user there are no pending calls and stop. If there are multiple invites, pick the one with the latest `received_at` (most recent).

2. **Accept it.** Call `mcp__peerd__peer_accept_invite` with that invite's `call_id`. Note the returned `session_token` for the call's duration.

3. **Caller has the floor first.** Call `mcp__peerd__peer_recv` with `timeout_s: 300` to wait for the caller's opening message.

4. **Conversation loop.** After every `peer_send`, the floor transfers — you MUST call `peer_recv` next (consecutive sends return `OUT_OF_TURN`). Loop:
   - `mcp__peerd__peer_recv`
   - If `kind: "send"`, reason about the caller's message and call `peer_send` to reply
   - If `kind: "human_inject"` and `tag` starts with `HUMAN-`, treat as authoritative override
   - If `kind: "ended"`, the caller ended the call. Summarize what was agreed for the user and stop
   - If `kind: "timeout"`, prompt the user about whether to wait or end

5. **You can also end the call.** When agreement is reached and the other side hasn't ended yet, call `mcp__peerd__peer_end` with structured `agreement` and `action_items`.

## Critical rules

- **You are responding to another AGENT, not a human.** Push back on ambiguity. Demand concrete types and field encodings. Don't agree just to be polite — that's how you end up with vague no-decisions.
- **Anchor in the local code.** Before agreeing to a contract, mentally check it against the actual code in this repo. If the peer proposes something incompatible with what you already have on this side, say so concretely with file/line references.
- **The user (your dev) is watching this call.** They may interject via human_inject from their side, tagged `HUMAN-<NAME>`. Those override anything I previously said. Acknowledge briefly and adjust.
- **Stay on topic.** The invite has a topic; don't drift. If something tangential comes up, suggest ending this call and starting a follow-up.
- **Report concisely after `peer_end`.** Three bullets: what was agreed, what you owe, what the peer owes.
