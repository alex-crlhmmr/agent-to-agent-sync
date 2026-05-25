---
name: action-items
description: Read the action_items.md and agreement.md from a past peer call back into the current session, so the user can act on follow-ups from a previous sync. Use when the user references a previous call or needs to pick up work from a handoff.
argument-hint: "[call-id]"
allowed-tools: Bash(ls ~/.claude/peerd/calls/*) Read
---

# /action-items — surface a past call's outcomes

Arguments: `$ARGUMENTS` is the `call_id` (full or prefix). If empty, list the most recent calls.

## Steps

1. **If no arg**, list recent calls so the user can pick one:

   !`ls -1t ~/.claude/peerd/calls/ 2>/dev/null | head -10`

   Tell the user to re-invoke with `/action-items <call-id>`.

2. **If arg present**, read both artifacts:
   - `~/.claude/peerd/calls/$ARGUMENTS/artifacts/agreement.md`
   - `~/.claude/peerd/calls/$ARGUMENTS/artifacts/action_items.md`

   Use `Read` for each. If the directory doesn't exist or files are missing, report and stop.

3. **Echo the contents** back to the user so they live in this session's context. Then offer to:
   - Start working on a specific action item, or
   - Open a follow-up call (`/call <peer> re: <topic>`) to verify completion or re-sync.

## Notes

- The full call transcript is at `~/.claude/peerd/calls/<call-id>/transcript.jsonl` if the user wants the raw record.
- These artifacts are the durable record that survives session compaction and `/clear`.
