---
name: make-available-for-call
description: Make THIS Claude Code session available to receive incoming peer-sync calls. By default new sessions are not reachable. Use when the user says they're ready to take calls, going on call duty, or wants a session to be the receiver.
argument-hint: "[label]"
allowed-tools: mcp__peerd__peer_make_available
---

# /make-available-for-call — open this session to incoming peer calls

By default Claude Code sessions are **NOT** reachable for peerd calls — callers see no available sessions until at least one session opts in via this skill (or via the `PEERD_AVAILABLE` env var at startup).

## Steps

1. Read the optional argument as the label for this session. If the user said something like:
   - `/make-available-for-call` (no arg) → no label
   - `/make-available-for-call work` → label="work"
   - `/make-available-for-call user-api refactor` → label="user-api refactor"
2. Call `mcp__peerd__peer_make_available` with `label` set to that string (or omit if no arg).
3. Confirm to the user briefly:
   - `✔ Now reachable for peer calls (label: <label>)` if labeled
   - `✔ Now reachable for peer calls` if unlabeled
4. Stop. Don't narrate further; user can keep working.

## Notes

- Sessions stay reachable until `/unavailable` is invoked OR the claude session exits.
- The label shows up in callers' session picker. Pick something the caller would recognize (project name, "work", "afk", etc.). If unlabeled, the picker just shows the cwd + when the session started.
- Multiple sessions can be available simultaneously. Callers using `peer_list_remote_sessions` see them all and can pick.
