---
name: call
description: Initiate a peer-sync call with another developer's Claude Code agent over peerd. Use when the user asks to call a teammate's agent, sync with another dev's session, or align on an interface contract that spans two layers.
argument-hint: "<peer-name> <topic>"
allowed-tools: mcp__peerd__peer_invite mcp__peerd__peer_recv mcp__peerd__peer_send mcp__peerd__peer_share_file mcp__peerd__peer_propose_change mcp__peerd__peer_end mcp__peerd__peer_human_inject mcp__peerd__peer_list_remote_sessions
---

# /call — initiate a peer-sync call

Arguments: `$1` is the peer name, `$2…` is the topic.

## Steps

1. **Check who's reachable on the peer.** Call `mcp__peerd__peer_list_remote_sessions` with `peer: "$1"`. Peerd is opt-in: only sessions where the receiver ran `/make-available-for-call` show up.

   - **If `sessions: []`**: tell the user `"<peer>'s claude sessions aren't accepting calls right now. Ask them to run /make-available-for-call."` Stop.
   - **If 1 session**: skip the picker. Note the `id` for use in the next step.
   - **If 2+ sessions**: use `AskUserQuestion` to let the user pick. Options should show:
     - The label if present, otherwise "(no label)"
     - The cwd (basename is enough)
     - How long ago it started
     Example option label: `"work — user-api (8m ago)"`. Keep options concise. Add an "Any" option as a 4th choice that means "let peerd route to whoever".

2. **Invite.** Call `mcp__peerd__peer_invite` with:
   - `peer: "$1"` (the response may include `auto_corrected` if there was a typo — mention to user).
   - `topic: "$2 $3 $4 …"`
   - `caller_label`: a short identifier for yourself
   - `context_excerpt`: 1–3 sentence summary of why you're calling
   - `target_session_id`: the `id` of the picked session. **Omit ONLY if user picked "Any" in the picker, or if there was only 1 session AND you want to let peerd decide (rare — prefer the explicit id).**
   - `timeout_s`: optional. Leave unset unless user gave an EXPLICIT time window.

3. **Handle the response:**
   - `accepted=true`: proceed to the conversation loop (step 4).
   - `accepted=false, reason=NO_AVAILABLE_SESSIONS`: tell user the peer's sessions just went away. Suggest retry later.
   - `accepted=false, reason=NO_SUCH_SESSION`: the targeted session went unavailable between list and invite. Re-run step 1 and retry.
   - `accepted=false, reason=INVITE_TIMEOUT`: peer didn't accept in time.
   - `accepted=false, reason=INVITE_DECLINED` (with a `reason` field): peer's agent declined. Surface the message.

4. **You have the floor first.** Open with a concrete proposal — anchor the call.
   - Use `mcp__peerd__peer_send` for normal turns (text).
   - If you have a CONCRETE FILE to share (type def, config, helper, snippet), use `mcp__peerd__peer_share_file` instead of pasting into peer_send — gives the peer structured metadata (path, language, hash) instead of a wall of text.
   - If during the conversation you decide a specific DIFF should land on the peer's side, use `mcp__peerd__peer_propose_change` with target_file + diff + rationale. The peer's agent will surface it to their human for explicit approval; never auto-applied.
   - All three (`peer_send`, `peer_share_file`, `peer_propose_change`) follow the same floor rules: must be your turn, transfer floor to peer after sending, so you `peer_recv` next.

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
