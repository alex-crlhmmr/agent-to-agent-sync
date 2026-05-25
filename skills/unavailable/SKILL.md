---
name: unavailable
description: Take THIS Claude Code session out of the pool of sessions reachable for peer calls. Use when the user wants to stop receiving calls but keep working in this session.
allowed-tools: mcp__peerd__peer_unmake_available
---

# /unavailable — stop receiving peer calls in this session

Removes this session from the peer call routing pool.

## Steps

1. Call `mcp__peerd__peer_unmake_available`.
2. Confirm briefly: `✔ No longer reachable for peer calls in this session.`
3. Stop.

## Notes

- The session itself stays open and the user can still INITIATE outbound calls (asymmetric: receiving is gated, calling is not).
- To make this session reachable again, the user runs `/make-available-for-call`.
- Other claude sessions on this machine that have opted in remain reachable independently.
