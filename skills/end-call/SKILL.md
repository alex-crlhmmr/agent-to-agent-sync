---
name: end-call
description: End the currently active peer call with a structured agreement and action items. Use when the user wants to hang up mid-conversation, or after a clear agreement has been reached.
allowed-tools: mcp__peerd__peer_end
---

# /end-call — end the active call

The user wants to end the active call cleanly with a durable record.

## Steps

1. Identify the active call. Use the `call_id` you've been working with in the current session. If you don't have one (e.g., the user invoked this without an active call in your context), ask them for the `call_id` or check via the status line.

2. Compose the agreement and action items from the conversation so far:
   - `agreement.summary`: 1–3 sentences capturing what was decided
   - `agreement.decisions`: array of `{topic, decision}` for each concrete point
   - `action_items`: `{owner, task, due?}` for each side's follow-up work — split between both devs

3. Call `mcp__peerd__peer_end` with:
   - `call_id`
   - `reason`: pick one of:
     - `"agreement_reached"` — the normal case
     - `"no_agreement"` — couldn't align; document what's still open
     - `"human_takeover"` — the user is taking over and continuing manually
     - `"decline"` — declining mid-call
   - `agreement` and `action_items` as above

4. Confirm to the user. Three bullets max: what was agreed, what each side owes, where the artifacts are.

## Notes

- The artifacts are written to `~/.claude/peerd/calls/<call_id>/artifacts/` on both machines automatically.
- After `peer_end`, the call is CLOSED — further `peer_send` attempts will fail.
