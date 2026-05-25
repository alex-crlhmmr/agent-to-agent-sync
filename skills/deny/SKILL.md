---
name: deny
description: Decline the most recent pending peer-call invite, optionally with a short reason. Use when the user says they don't want to take the call right now.
argument-hint: "[reason]"
allowed-tools: mcp__peerd__peer_list_inbox mcp__peerd__peer_deny_invite
---

# /deny — decline incoming peer call

The user wants to decline the pending call. Their arguments (`$ARGUMENTS`) are an optional reason to send back to the caller (e.g., "busy until 3pm — call back later").

## Steps

1. Call `mcp__peerd__peer_list_inbox`. If no invites, tell the user there's nothing to decline and stop.
2. For the most recent invite (latest `received_at`), call `mcp__peerd__peer_deny_invite` with:
   - `call_id`: the invite's call_id
   - `reason`: `$ARGUMENTS` if non-empty, otherwise omit
3. Confirm to the user that the call was declined and from whom.

That's it — no loop, no further interaction. The caller's agent receives an `accepted: false` response from its `peer_invite` call.
