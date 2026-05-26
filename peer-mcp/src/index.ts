// peer-mcp — Claude Code MCP server bridging to local peerd.
//
// Tools exposed:
//   peer_invite          - start a call (with fuzzy peer-name matching)
//   peer_list_peers      - directory of known peers + online state
//   peer_list_inbox      - pending invites for this side
//   peer_accept_invite   - accept by call_id
//   peer_deny_invite     - decline by call_id
//   peer_recv            - long-poll for next message in a call
//   peer_send            - send next message
//   peer_end             - end the call with structured agreement
//   peer_human_inject    - relay a tagged HUMAN-* override
//
// Plus an AMBIENT background loop: subscribes to peerd's inbox at startup
// and, whenever an invite arrives, fires server.elicitInput() directly so
// the user sees an arrow-key Accept/Decline/Send-message popup in Claude
// Code — no /listen typing required.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PeerdClient } from "./peerd_client.js";

// Tee stderr to a log file so we can debug regardless of how Claude Code routes MCP stderr.
// Path is derived from the control socket path so each side has its own log.
const LOG_DIR = process.env.PEERD_LOG_DIR ?? path.join(os.homedir(), ".claude", "peerd");
const LOG_PATH = path.join(LOG_DIR, `peer-mcp-${process.pid}.log`);
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch { /* ignore */ }
let logStream: fs.WriteStream | undefined;
try { logStream = fs.createWriteStream(LOG_PATH, { flags: "a" }); } catch { /* ignore */ }
const origStderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = ((chunk: any, ...rest: any[]) => {
  try { logStream?.write(chunk); } catch { /* ignore */ }
  return origStderrWrite(chunk, ...rest);
}) as any;
console.error(`[peer-mcp] log file: ${LOG_PATH}`);
console.error(`[peer-mcp] pid: ${process.pid}, control socket: ${process.env.PEERD_CONTROL_SOCK ?? "(default)"}`);

const SOCKET_PATH =
  process.env.PEERD_CONTROL_SOCK ??
  path.join(os.homedir(), ".claude", "peerd", "control.sock");

interface PeerEntry { name: string; host: string; port: number; online: boolean; }

// ── tiny Levenshtein for fuzzy peer-name matching ────────────────
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const al = a.length, bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;
  const prev = new Array(bl + 1);
  for (let j = 0; j <= bl; j++) prev[j] = j;
  for (let i = 1; i <= al; i++) {
    let cur = i;
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const next = Math.min(cur + 1, prev[j] + 1, prev[j - 1] + cost);
      prev[j - 1] = cur;
      cur = next;
    }
    prev[bl] = cur;
  }
  return prev[bl];
}

function resolvePeer(input: string, peers: PeerEntry[]): { name: string; auto_corrected?: { from: string; distance: number } } | null {
  const lower = input.toLowerCase();
  const exact = peers.find((p) => p.name.toLowerCase() === lower);
  if (exact) return { name: exact.name };
  if (peers.length === 0) return null;
  // Pick closest with a distance threshold (≤ 3 edits OR ≤ 40% of name length)
  let best: PeerEntry | null = null;
  let bestDist = Infinity;
  for (const p of peers) {
    const d = levenshtein(lower, p.name.toLowerCase());
    if (d < bestDist) { best = p; bestDist = d; }
  }
  if (!best) return null;
  const threshold = Math.max(3, Math.floor(best.name.length * 0.4));
  if (bestDist > threshold) return null;
  return { name: best.name, auto_corrected: { from: input, distance: bestDist } };
}

// Tracks call_ids that THIS session resolved locally (accepted or denied)
// via tool calls. Used twice:
//   (a) Suppress the self-broadcast of invite_resolved we'd otherwise emit
//       a confusing "accepted in another session" channel block for.
//   (b) Mark THIS session as the "owner" of the call_id, so subsequent
//       connected/message/ended channel events are emitted ONLY for calls
//       this session has actually accepted/initiated. Without this, every
//       open claude session would get connected events for every call on
//       the machine and race to peer_recv.
// (a) clears the entry after one use. (b) reads the entry on every poll
// tick; we use a separate set for (b) so (a)'s cleanup doesn't break it.
const handledLocally = new Set<string>();
const ownedByThisSession = new Set<string>();

async function main() {
  const client = await PeerdClient.connect(SOCKET_PATH).catch((err) => {
    console.error(`[peer-mcp] failed to connect to peerd at ${SOCKET_PATH}: ${err.message}`);
    console.error(`[peer-mcp] is peerd running? set PEERD_CONTROL_SOCK if it's at a non-default path.`);
    process.exit(2);
  });

  const server = new McpServer(
    { name: "peer-mcp", version: "0.3.0" },
    {
      // Declare claude/channel capability so Claude Code routes our
      // notifications/claude/channel events into the agent's context.
      // Per https://code.claude.com/docs/en/channels-reference#server-options
      capabilities: {
        experimental: {
          "claude/channel": {},
        },
        tools: {},
      },
      instructions:
        "You are connected to peerd — a peer-to-peer chat bridge between developer agents.\n\n" +
        "IMPORTANT: This session is NOT reachable for incoming calls by default. The user must opt-in via the /make-available-for-call skill (or by launching claude with PEERD_AVAILABLE=1). If they ask why peers can't call them, that's why.\n\n" +
        "CALLER FLOW — when the user asks to call <peer> about <topic>:\n" +
        "  1. Call mcp__peerd__peer_list_remote_sessions(peer) FIRST.\n" +
        "  2. Look at the returned sessions array:\n" +
        "     - If empty: tell user '<peer> isn't accepting calls right now (no claude session is opted in).' Stop.\n" +
        "     - If 1 session: call mcp__peerd__peer_invite with target_session_id=<that session's id>. No picker needed.\n" +
        "     - If 2+ sessions: use AskUserQuestion to let user pick. Options should show label, cwd, and started-age (e.g. \"work — ~/projects/user-api (8m ago)\"). Then peer_invite with the chosen target_session_id.\n" +
        "  3. If invite returns {accepted: false, reason: \"NO_SUCH_SESSION\"}: the targeted session went unavailable between list and invite. Re-run peer_list_remote_sessions and retry.\n" +
        "  4. If accepted: drive the recv/send loop as before.\n\n" +
        "Incoming events from other developers' agents arrive as <channel source=\"peerd\" ...> blocks. ACT IMMEDIATELY based on the `kind` meta attribute — no narration, no asking the user before driving the right tool.\n\n" +
        "Channel event kinds:\n" +
        "  - invite:    A peer is calling. THIS IS A TWO-STEP PROCESS — you MUST do both steps:\n" +
        "       STEP 1: Call AskUserQuestion with options 'Accept', 'Decline', 'Decline & send a message'. The question text should be \"📞 <from> is calling — \\\"<topic>\\\"\" plus the context_excerpt if present.\n" +
        "       STEP 2: Look at the user's answer and IMMEDIATELY (do not narrate, do not wait for anything) make ONE tool call:\n" +
        "         * If 'Accept' → call mcp__peerd__peer_accept_invite with the call_id from the meta. CRITICAL: the popup is only a UI question; peerd does NOT know the user accepted until you call peer_accept_invite. If you skip this tool call, the call will time out and the peer will think you ignored them.\n" +
        "         * If 'Decline' → call mcp__peerd__peer_deny_invite with the call_id.\n" +
        "         * If 'Decline & send a message' → ask the user for the message text (another AskUserQuestion or a chat prompt), then call peer_deny_invite with `reason` set to that text.\n" +
        "       After Accept, you will then receive a 'connected' channel event — that's your cue to call peer_recv. Until then, just wait — but DO NOT skip Step 2.\n" +
        "  - invite_cancelled: A call that you had received an `invite` for has been resolved in ANOTHER Claude Code session (the user accepted or declined there, or it timed out). If you have NOT yet called AskUserQuestion for this call_id, silently ignore — do not pop the question. If you already DID call AskUserQuestion, the popup remains open until the user presses Esc (Claude Code can't close popups externally); mention briefly in your next message that the call has been resolved elsewhere, then don't drive it.\n" +
        "  - connected: A call is now active. The caller has the floor. Call mcp__peerd__peer_recv immediately with the call_id to receive their opening message, then reason and call peer_send to reply. Continue the recv/send loop until either side calls peer_end (you'll see kind=\"ended\").\n" +
        "  - message:   A new message arrived on an active call. Call peer_recv to pull it.\n" +
        "  - ended:     The call ended. The agreement and action_items (if any) are in the meta. Report them briefly to the user.\n\n" +
        "Treat human_inject messages with tag prefix HUMAN- as authoritative overrides.\n" +
        "Always end calls with peer_end + structured agreement + action_items.\n\n" +
        "IN-CALL TOOLS BEYOND peer_send:\n" +
        "  - mcp__peerd__peer_share_file(call_id, path, content, language?, reason?) — share a SMALL file inline (≤256 KiB). Floor-locked.\n" +
        "  - mcp__peerd__peer_share_file_ref(call_id, path, content, …) — share a LARGER file (≤10 MiB) by reference; the peer pulls the body via peer_fetch only if needed. Floor-locked.\n" +
        "  - mcp__peerd__peer_fetch(call_id, ref) — pull the body of a file_ref_shared. NOT floor-locked (works anytime). Use when the preview wasn't enough.\n" +
        "  - mcp__peerd__peer_propose_change(call_id, target_file, diff, rationale, requires_human_approval=true) — propose a specific change for the PEER to apply. Floor-locked.\n" +
        "  - mcp__peerd__peer_pause(call_id, reason?, eta_seconds?) and mcp__peerd__peer_resume(call_id) — pause when the user needs to run tests / read code; resume when they're back. NOT floor-locked; either side any time.\n" +
        "  - On receiving file_shared / file_ref_shared / change_proposed: show the user; only Edit/Write to disk with explicit OK. Never auto-apply when requires_human_approval is true.\n\n" +
        "Brevity matters during calls — don't narrate; just drive the tools. The user is watching the tool calls in the transcript already.",
    },
  );

  // Helpers ─────────────────────────────────────────────────────────
  async function listPeers(): Promise<PeerEntry[]> {
    const res = await client.call<{ peers: PeerEntry[] }>("list_peers", {});
    return res.peers ?? [];
  }

  function asTextResult(obj: unknown) {
    return { content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] };
  }

  // ── peer_invite ────────────────────────────────────────────────
  server.registerTool(
    "peer_invite",
    {
      description: "Initiate a peer-sync call. If `peer` doesn't exactly match a known peer name, the closest match is used automatically (with a note in the result). Blocks until the peer accepts/declines or the timeout fires (default 2.5 minutes). Returns the call_id to use with peer_send / peer_recv / peer_end. If the peer's claude side hasn't opted in to receive calls (no /make-available-for-call), this returns accepted=false with reason=NO_AVAILABLE_SESSIONS. To target a specific session on a peer with multiple sessions available, pass target_session_id from peer_list_remote_sessions.",
      inputSchema: {
        peer: z.string().describe("Peer name (case-insensitive). Typos are auto-corrected to the closest known name."),
        topic: z.string().describe("Short topic, shown on the callee's incoming-call popup."),
        caller_label: z.string().optional().describe("How to identify yourself (e.g., \"bob@layer-b\")."),
        context_excerpt: z.string().optional().describe("1-3 sentences of context shown to the callee in the popup."),
        timeout_s: z.number().int().min(5).max(600).optional().describe("Seconds to wait for the peer to ACCEPT before timing out. Default 150 (2.5 min). Only set if the user gave an explicit time window."),
        target_session_id: z.string().optional().describe("Optional: target a specific subscriber on the peer (from peer_list_remote_sessions). If omitted, the call routes to the peer's newest available session. If set and that session is no longer available, the invite fails with reason=NO_SUCH_SESSION (no fallback)."),
      },
    },
    async (input) => {
      const peers = await listPeers();
      const resolved = resolvePeer(input.peer, peers);
      if (!resolved) {
        return asTextResult({
          error: "UNKNOWN_PEER",
          message: `No peer matched "${input.peer}". Known peers: ${peers.map((p) => p.name).join(", ") || "(none)"}.`,
          known_peers: peers,
        });
      }
      const params: Record<string, unknown> = {
        peer: resolved.name,
        topic: input.topic,
      };
      if (input.caller_label) params.caller_label = input.caller_label;
      if (input.context_excerpt) params.context_excerpt = input.context_excerpt;
      if (input.timeout_s !== undefined) params.invite_timeout_s = input.timeout_s;
      if (input.target_session_id) params.target_session_id = input.target_session_id;
      const inviteTimeoutS = input.timeout_s ?? 150;
      const res = await client.call<{ call_id: string; accepted: boolean; reason?: string; session_token?: string }>(
        "invite",
        params,
        { timeoutMs: (inviteTimeoutS + 20) * 1000 },
      );
      if (res?.call_id && res.accepted) ownedByThisSession.add(res.call_id);
      return asTextResult({ ...res, auto_corrected: resolved.auto_corrected });
    },
  );

  // ── peer_make_available ────────────────────────────────────────
  server.registerTool(
    "peer_make_available",
    {
      description: "Make THIS claude session available to receive peer calls. By default a new session is NOT reachable — callers won't see it in peer_list_remote_sessions and can't invite it. Call this once when the user signals readiness (e.g., /make-available-for-call, or starts work expecting calls). Optional `label` lets callers target this specific session by name.",
      inputSchema: {
        label: z.string().optional().describe("Optional short name (e.g., \"work\", \"user-api\") shown to callers in their session picker."),
      },
    },
    async ({ label }) => {
      if (!mySubscriberId) {
        return asTextResult({ error: "NOT_SUBSCRIBED", message: "peer-mcp hasn't received its subscriber_id yet. Try again in a moment." });
      }
      const params: Record<string, unknown> = {
        subscriber_id: mySubscriberId,
        available: true,
        cwd: process.cwd(),
      };
      if (label) params.label = label;
      const res = await client.call("set_session_metadata", params, { timeoutMs: 3000 });
      return asTextResult(res);
    },
  );

  // ── peer_unmake_available ──────────────────────────────────────
  server.registerTool(
    "peer_unmake_available",
    {
      description: "Take THIS claude session OUT of the pool of sessions reachable for peer calls. After this, peer_list_remote_sessions won't include us and we can't be invited (until peer_make_available is called again).",
      inputSchema: {},
    },
    async () => {
      if (!mySubscriberId) {
        return asTextResult({ error: "NOT_SUBSCRIBED", message: "peer-mcp hasn't received its subscriber_id yet." });
      }
      const res = await client.call("set_session_metadata", {
        subscriber_id: mySubscriberId,
        available: false,
      }, { timeoutMs: 3000 });
      return asTextResult(res);
    },
  );

  // ── peer_list_remote_sessions ──────────────────────────────────
  server.registerTool(
    "peer_list_remote_sessions",
    {
      description: "List the claude sessions currently available to receive a call on a given peer (only sessions where the receiver ran /make-available-for-call). Returns array of {id, label?, cwd?, subscribed_at}. Use BEFORE peer_invite: if 0 sessions, tell user the peer isn't reachable; if 1 session, call peer_invite with that target_session_id directly; if 2+ sessions, use AskUserQuestion to let user pick.",
      inputSchema: {
        peer: z.string().describe("Peer name (typos auto-corrected as in peer_invite)."),
      },
    },
    async ({ peer }) => {
      const peers = await listPeers();
      const resolved = resolvePeer(peer, peers);
      if (!resolved) {
        return asTextResult({
          error: "UNKNOWN_PEER",
          message: `No peer matched "${peer}". Known peers: ${peers.map((p) => p.name).join(", ") || "(none)"}.`,
        });
      }
      try {
        const res = await client.call<{ sessions: any[] }>("list_remote_sessions", { peer: resolved.name }, { timeoutMs: 8000 });
        return asTextResult({ peer: resolved.name, sessions: res.sessions });
      } catch (e: any) {
        return asTextResult({
          error: e?.code ?? "ERROR",
          message: e?.message ?? String(e),
          peer: resolved.name,
        });
      }
    },
  );

  // ── peer_list_peers ────────────────────────────────────────────
  server.registerTool(
    "peer_list_peers",
    {
      description: "List configured peers and whether each is currently online. Use to know who the user can call. Online means peerd has an active WSS connection to that peer.",
      inputSchema: {},
    },
    async () => {
      const peers = await listPeers();
      return asTextResult({ peers });
    },
  );

  // ── peer_list_inbox ────────────────────────────────────────────
  server.registerTool(
    "peer_list_inbox",
    {
      description: "List pending incoming peer-call invites. Each entry has call_id, from, topic. Normally you don't need this — the ambient popup handles incoming calls — but useful if you want to see what's pending.",
      inputSchema: {},
    },
    async () => {
      const res = await client.call<{ invites: any[] }>("list_inbox", {});
      return asTextResult(res);
    },
  );

  // ── peer_accept_invite ─────────────────────────────────────────
  server.registerTool(
    "peer_accept_invite",
    {
      description: "Accept a pending incoming invite by call_id. Call this after the AskUserQuestion popup returns 'Accept'. The popup is only UI; peerd does NOT know the user accepted until you call this tool.",
      inputSchema: {
        call_id: z.string(),
      },
    },
    async ({ call_id }) => {
      handledLocally.add(call_id);      // suppress self-broadcast of invite_resolved
      ownedByThisSession.add(call_id);  // claim ownership of this call's events
      return asTextResult(await client.call("accept_invite", { call_id }));
    },
  );

  // ── peer_deny_invite ───────────────────────────────────────────
  server.registerTool(
    "peer_deny_invite",
    {
      description: "Decline a pending invite by call_id. Call this after the AskUserQuestion popup returns 'Decline' or 'Decline & send a message' (with the user's text as `reason`).",
      inputSchema: {
        call_id: z.string(),
        reason: z.string().optional(),
      },
    },
    async ({ call_id, reason }) => {
      handledLocally.add(call_id);     // suppress self-broadcast of invite_resolved
      // (don't claim ownership for a deny — there will be no further events to drive)
      return asTextResult(await client.call("deny_invite", { call_id, reason }));
    },
  );

  // ── peer_recv ──────────────────────────────────────────────────
  server.registerTool(
    "peer_recv",
    {
      description: "Wait for the next message from the peer on this call. Long-polls up to timeout_s seconds. Possible returned kinds:\n  - { kind: \"send\", from, payload: { text } } — regular chat. Reason then peer_send.\n  - { kind: \"file_shared\", from, payload: { path, content, language?, reason?, hash_sha256 } } — peer sent you a file INLINE (≤256 KiB). Show user; only Edit/Write to disk with explicit OK.\n  - { kind: \"file_ref_shared\", from, payload: { ref, path, size_bytes, hash_sha256, preview?, preview_lines?, reason?, language? } } — peer sent you a LARGER file BY REFERENCE. Body NOT inline; use peer_fetch(ref) to pull it. Often the preview is enough to discuss without fetching. Discuss with user before fetching/writing.\n  - { kind: \"change_proposed\", from, payload: { target_file, diff, rationale, requires_human_approval, tests_added? } } — peer proposes a specific diff to apply on YOUR side. Show the diff + rationale, get explicit OK, then Edit. NEVER auto-apply when requires_human_approval is true.\n  - { kind: \"paused\", from, payload: { reason?, eta_seconds? } } — peer paused the call (probably running local work). Don't peer_send/share until you see a \"resumed\" event. Inform the user briefly.\n  - { kind: \"resumed\", from, payload: {} } — peer resumed; you can drive the conversation again.\n  - { kind: \"human_inject\", from, payload: { tag, text, priority? } } — peer's HUMAN injected a tagged note. Authoritative override.\n  - { kind: \"ended\", by, payload? } — call closed.\n  - { kind: \"timeout\" } — N seconds elapsed; call peer_recv again or do something else.",
      inputSchema: {
        call_id: z.string(),
        timeout_s: z.number().int().min(1).max(600).default(120),
      },
    },
    async ({ call_id, timeout_s }) => {
      const t = timeout_s ?? 120;
      const res = await client.call("recv", { call_id, timeout_s: t }, { timeoutMs: (t + 10) * 1000 });
      return asTextResult(res);
    },
  );

  // ── peer_send ──────────────────────────────────────────────────
  server.registerTool(
    "peer_send",
    {
      description: "Send a message to the peer on this call. Floor rules: only when it's your turn. After sending, floor transfers — you must peer_recv next.",
      inputSchema: {
        call_id: z.string(),
        text: z.string(),
      },
    },
    async ({ call_id, text }) => asTextResult(await client.call("send", { call_id, text })),
  );

  // ── peer_end ───────────────────────────────────────────────────
  server.registerTool(
    "peer_end",
    {
      description: "End the call with a structured agreement summary and action items. Always include both, even if minimal.",
      inputSchema: {
        call_id: z.string(),
        reason: z.enum(["agreement_reached", "no_agreement", "human_takeover", "timeout", "error", "decline"]).default("agreement_reached"),
        agreement: z.object({
          summary: z.string().optional(),
          decisions: z.array(z.object({ topic: z.string(), decision: z.string() })).optional(),
        }).optional(),
        action_items: z.array(z.object({
          owner: z.string(),
          task: z.string(),
          due: z.string().optional(),
        })).optional(),
      },
    },
    async (input) => asTextResult(await client.call("end", input)),
  );

  // ── peer_share_file ────────────────────────────────────────────
  server.registerTool(
    "peer_share_file",
    {
      description: "Send a file inline to the peer mid-call. Use when there's a CONCRETE file/snippet to share (a type definition, a config, a small helper) — much better than pasting into peer_send because the receiver gets the path + language + hash as structured metadata. Hard cap: 256 KiB of content. The receiver's agent will see this as a structured file event in their context and decide what to do with it (often: read + reference in the conversation, or apply via Edit if you also proposed a change). Same floor-rules as peer_send: must be your turn; after sending, the peer has the floor (you must peer_recv next).",
      inputSchema: {
        call_id: z.string(),
        path: z.string().describe("Logical path of the file (e.g., \"schemas/user.ts\"). Need not exist on receiver — they see it as the source-of-truth label."),
        content: z.string().describe("Full file content. Max 256 KiB UTF-8."),
        language: z.string().optional().describe("Optional language hint (e.g., \"typescript\", \"go\")."),
        reason: z.string().optional().describe("1-sentence why you're sharing this — gives the peer agent context for what to do with it."),
      },
    },
    async ({ call_id, path: filePath, content, language, reason }) => {
      try {
        const res = await client.call("share_file", {
          call_id,
          path: filePath,
          content,
          language,
          reason,
        });
        return asTextResult(res);
      } catch (e: any) {
        return asTextResult({ error: e?.code ?? "ERROR", message: e?.message ?? String(e) });
      }
    },
  );

  // ── peer_propose_change ────────────────────────────────────────
  server.registerTool(
    "peer_propose_change",
    {
      description: "Propose a specific code change for the PEER to apply on their side. Use when you've identified a concrete diff (one-or-two-file scoped) that should land on the peer's repo, not yours. The diff is data — peerd never auto-applies. The receiver's agent will see your proposal as a structured event and, only after discussing with their human, may apply it via their own Edit tool. Same floor-rules as peer_send.",
      inputSchema: {
        call_id: z.string(),
        target_file: z.string().describe("File path on the peer's side that should be modified."),
        diff: z.string().describe("Unified diff (git/unidiff style). Keep concise — large refactors should be discussed first, not proposed as a single diff."),
        rationale: z.string().describe("Why this change. 1-3 sentences. The peer's agent surfaces this to their human."),
        requires_human_approval: z.boolean().optional().describe("Default true. Set false ONLY if the change is trivially safe (e.g. typo fix) and the call has already reached agreement on it."),
        tests_added: z.array(z.object({
          path: z.string(),
          diff: z.string(),
        })).optional().describe("Optional: companion test changes that go with this proposal."),
      },
    },
    async (input) => {
      try {
        const res = await client.call("propose_change", input);
        return asTextResult(res);
      } catch (e: any) {
        return asTextResult({ error: e?.code ?? "ERROR", message: e?.message ?? String(e) });
      }
    },
  );

  // ── peer_share_file_ref ────────────────────────────────────────
  server.registerTool(
    "peer_share_file_ref",
    {
      description: "Share a LARGER file (up to 10 MiB) by reference. Full content stays on YOUR side; the peer's agent sees only metadata + a small preview, and can pull the body on demand via peer_fetch. Use when content exceeds 256 KiB (otherwise prefer peer_share_file inline) — whole modules, big configs, generated schemas. Same floor-rules as peer_send. Caller's peerd stores the content in memory until the call ends.",
      inputSchema: {
        call_id: z.string(),
        path: z.string().describe("Logical path label (e.g., \"src/big/module.ts\")."),
        content: z.string().describe("Full file content (≤10 MiB UTF-8)."),
        reason: z.string().optional().describe("1-sentence why you're sharing."),
        language: z.string().optional(),
        preview_chars: z.number().int().min(0).max(1024).optional().describe("How many chars of content to include as preview (default 200, max 1024). Preview helps the peer agent decide whether to fetch the full body."),
      },
    },
    async (input) => {
      try {
        const res = await client.call("share_file_ref", input, { timeoutMs: 30_000 });
        return asTextResult(res);
      } catch (e: any) {
        return asTextResult({ error: e?.code ?? "ERROR", message: e?.message ?? String(e) });
      }
    },
  );

  // ── peer_fetch ─────────────────────────────────────────────────
  server.registerTool(
    "peer_fetch",
    {
      description: "Fetch the full content of a ref the peer previously shared via peer_share_file_ref. Use when you got a file_ref_shared event and need the body to read/apply. NOT floor-locked — works at any time during the call. Returns { content, hash_sha256 }, or an error with REF_UNAVAILABLE if the ref is unknown or the call has ended.",
      inputSchema: {
        call_id: z.string(),
        ref: z.string().describe("The `ref` id from the file_ref_shared event payload."),
        timeout_s: z.number().int().min(1).max(120).optional().describe("Seconds to wait for the peer's response. Default 30."),
      },
    },
    async ({ call_id, ref, timeout_s }) => {
      try {
        const res = await client.call("fetch_ref", { call_id, ref, timeout_s }, { timeoutMs: ((timeout_s ?? 30) + 5) * 1000 });
        return asTextResult(res);
      } catch (e: any) {
        return asTextResult({ error: e?.code ?? "ERROR", message: e?.message ?? String(e) });
      }
    },
  );

  // ── peer_pause ─────────────────────────────────────────────────
  server.registerTool(
    "peer_pause",
    {
      description: "Pause the active call. Use when YOU (or the user) need to do local work mid-call — running tests, reading code, thinking — and the peer should know to wait. NOT floor-locked: pause/resume can happen any time, by either side. Both sides see state=PAUSED. The peer's agent will get a kind=\"paused\" event on its next peer_recv.",
      inputSchema: {
        call_id: z.string(),
        reason: z.string().optional().describe("Short reason shown to the peer (e.g., \"running tests\")."),
        eta_seconds: z.number().int().min(1).max(3600).optional().describe("Approximate seconds until resume. Just a hint for the peer."),
      },
    },
    async ({ call_id, reason, eta_seconds }) => {
      try {
        const res = await client.call("pause", { call_id, reason, eta_seconds });
        return asTextResult(res);
      } catch (e: any) {
        return asTextResult({ error: e?.code ?? "ERROR", message: e?.message ?? String(e) });
      }
    },
  );

  // ── peer_resume ────────────────────────────────────────────────
  server.registerTool(
    "peer_resume",
    {
      description: "Resume a paused call. Either side can resume regardless of who paused. Returns both sides to state=CONNECTED. The peer's agent will get a kind=\"resumed\" event.",
      inputSchema: {
        call_id: z.string(),
      },
    },
    async ({ call_id }) => {
      try {
        const res = await client.call("resume_call", { call_id });
        return asTextResult(res);
      } catch (e: any) {
        return asTextResult({ error: e?.code ?? "ERROR", message: e?.message ?? String(e) });
      }
    },
  );

  // ── peer_human_inject ──────────────────────────────────────────
  server.registerTool(
    "peer_human_inject",
    {
      description: "Inject a tagged human override into an active call. Use ONLY when the user explicitly tells you to relay something to the peer, e.g. \"tell alice we don't need versioning\".",
      inputSchema: {
        call_id: z.string(),
        tag: z.string(),
        text: z.string(),
        priority: z.enum(["override", "advisory"]).optional(),
      },
    },
    async (input) => asTextResult(await client.call("human_inject", input)),
  );

  // ── Boot the MCP transport ─────────────────────────────────────
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[peer-mcp] ready, connected to peerd at ${SOCKET_PATH}`);

  // ── Ambient invite handler ─────────────────────────────────────
  // Channel notifications are the primary UX: peer-mcp emits notifications/claude/channel
  // and Claude Code (launched with --channels) injects them into the agent's
  // context. The agent then decides to call peer_accept_invite, at which point
  // Claude Code's NATIVE permission prompt fires — that IS the Accept/Decline
  // arrow-key picker.
  //
  // The elicitation popup that was here before is intentionally removed — it
  // duplicated the permission prompt with worse UX.
  const caps = server.server.getClientCapabilities();
  console.error(`[peer-mcp] client capabilities: ${JSON.stringify(caps ?? {})}`);
  startChannelBridge(server, client).catch((err) => {
    console.error("[peer-mcp] channel bridge died:", err?.message ?? err);
  });
}

/**
 * Channel bridge: subscribes to peerd events and emits notifications/claude/channel
 * for each interesting one. When delivered, Claude Code renders them as
 * <channel source="peerd" kind="..."> blocks in the agent's context, waking it.
 */
/** Captured at startup from peerd's first subscribe_inbox notification. */
let mySubscriberId: string | null = null;

/**
 * If PEERD_AVAILABLE env var is set, opt this session in automatically on
 * subscriber_id arrival. Values:
 *   PEERD_AVAILABLE=1 / true     → available, no label
 *   PEERD_AVAILABLE=<anything>   → available, label = that string
 */
async function maybeAutoMakeAvailable(client: PeerdClient): Promise<void> {
  if (!mySubscriberId) return;
  const raw = process.env.PEERD_AVAILABLE;
  if (!raw) return;
  const params: Record<string, unknown> = {
    subscriber_id: mySubscriberId,
    available: true,
    cwd: process.cwd(),
  };
  if (raw !== "1" && raw.toLowerCase() !== "true") params.label = raw;
  await client.call("set_session_metadata", params, { timeoutMs: 3000 });
  console.error(`[peer-mcp] auto-made-available (label=${params.label ?? "(none)"})`);
}

async function startChannelBridge(server: McpServer, client: PeerdClient): Promise<void> {
  console.error("[peer-mcp] starting channel bridge");

  // Track which call_ids we've emitted "invite" for so we don't double-emit.
  const invitedSeen = new Set<string>();
  // Track which call_ids have been resolved (accepted/declined elsewhere)
  // BEFORE we got around to emitting them. We won't emit invites for these.
  const resolvedBeforeEmit = new Set<string>();
  // Track which call_ids THIS session "owns" — meaning it's the one that should
  // drive the connected/message/ended channel events for that call. A session
  // owns a call if it accepted the invite locally (handledLocally on accept) OR
  // if it initiated the call locally via peer_invite. Without this, a second
  // session that happens to see the same call's "connected" event would race
  // the primary session to peer_recv and burn tokens for no reason.
  // (Note: handledLocally is already declared at module scope above for the
  // self-broadcast-suppress logic; we reuse it here for ownership.)

  // Subscribe to incoming invites + resolution events.
  client.subscribe("subscribe_inbox", {}, (n: unknown) => {
    const note = n as { kind?: string; payload?: any };

    // First notification: peerd assigns this session a subscriber_id.
    if (note?.kind === "subscribed") {
      mySubscriberId = note.payload?.subscriber_id ?? null;
      console.error(`[peer-mcp] my subscriber_id: ${mySubscriberId}`);
      // If PEERD_AVAILABLE is set, opt this session in to receiving calls
      // automatically (so users who set the env at `claude` launch don't
      // need to type /make-available-for-call).
      maybeAutoMakeAvailable(client).catch((e) =>
        console.error(`[peer-mcp] auto make-available failed: ${e?.message ?? e}`),
      );
      return;
    }

    if (note?.kind === "invite") {
      const inv = note.payload;
      if (!inv?.call_id || invitedSeen.has(inv.call_id)) return;
      // peerd marks the notification with `silent: true` when another claude
      // session is presumably handling this invite (either it's a replay and
      // another session is already subscribed, or it's a fresh broadcast and
      // this session isn't the oldest subscriber). Skip the popup in those
      // cases — we'd only be redundant. `replay_silent` is an older name kept
      // for back-compat with mid-upgrade peerds.
      const noteAny = note as { silent?: boolean; replay_silent?: boolean };
      if (noteAny.silent || noteAny.replay_silent) {
        return;
      }
      // Race-guard: if peerd already told us this invite was resolved in another
      // session, just suppress entirely — never emit anything.
      if (resolvedBeforeEmit.has(inv.call_id)) {
        resolvedBeforeEmit.delete(inv.call_id);
        return;
      }
      invitedSeen.add(inv.call_id);
      emitChannel(server, {
        kind: "invite",
        call_id: inv.call_id,
        from: inv.from,
        topic: inv.topic ?? "",
        caller_label: inv.caller_label ?? "",
        content:
          `Incoming peer call from ${inv.from} (${inv.caller_label ?? "no label"}).\n` +
          `Topic: ${inv.topic}\n` +
          (inv.context_excerpt ? `Context: ${inv.context_excerpt}\n` : "") +
          `Call ID: ${inv.call_id}\n\n` +
          `The user will be asked to accept/decline via a popup. After they accept, you'll receive a "connected" channel event with the same call_id — that's when you should engage by calling mcp__peerd__peer_recv.`,
      });
      return;
    }

    if (note?.kind === "invite_resolved") {
      const { call_id, resolution } = note.payload as { call_id: string; resolution: string };
      if (!call_id) return;
      // Suppress self-broadcast: if THIS session called accept_invite / deny_invite,
      // we already know how the invite was resolved; don't emit a confusing
      // "accepted in another session" channel block to our own agent.
      if (handledLocally.has(call_id)) {
        handledLocally.delete(call_id);
        return;
      }
      if (invitedSeen.has(call_id)) {
        // We already emitted the invite event in this session — push a
        // cancellation block so the agent can abandon the popup logic if
        // it hasn't already called AskUserQuestion. (If the popup is
        // already open, only the user pressing Esc closes it — but at
        // least the chat shows context for why.)
        emitChannel(server, {
          kind: "invite_cancelled",
          call_id,
          resolution,
          content:
            `Call ${call_id} was ${resolution === "accepted" ? "accepted in another session" : resolution === "declined" ? "declined elsewhere" : "ended/timed out"}.\n\n` +
            `If you haven't yet called AskUserQuestion for this call, do NOT call it now — silently ignore. If you have, the user will need to press Esc to dismiss the popup (we can't close it externally).`,
        });
      } else {
        // We haven't emitted the invite yet (race: resolution beat the
        // invite notification through our subscriber). Mark so the next
        // 'invite' notification for this call_id is suppressed.
        resolvedBeforeEmit.add(call_id);
        // Auto-expire after 10s so the set doesn't grow unbounded.
        setTimeout(() => resolvedBeforeEmit.delete(call_id), 10_000).unref();
      }
      return;
    }
  });

  // Poll for call-state changes (connected, message arrived, ended) every second.
  // peerd doesn't yet expose a wait_for_event RPC, so we poll list_calls + check
  // whether anything changed since last tick. Cheap because both peerd and
  // peer-mcp are local.
  //
  // IMPORTANT: pre-seed lastState with current state on first run so we DON'T
  // emit "connected" channel events for calls that were already active when
  // this MCP server boots (e.g., from a previous Claude Code session that
  // left calls in CONNECTED). Otherwise the agent gets spammed with stale
  // call events on every restart.
  const lastState = new Map<string, { state: string; floor: string }>();
  try {
    const initial = await client.call<{ calls: any[] }>("list_calls", {});
    for (const c of initial.calls ?? []) {
      lastState.set(c.call_id, { state: c.state, floor: c.floor });
    }
    console.error(`[peer-mcp] channel bridge: seeded ${lastState.size} pre-existing call(s) into state map (no events emitted for them)`);
  } catch (e: any) {
    console.error(`[peer-mcp] channel bridge: initial list_calls failed: ${e?.message ?? e}`);
  }
  setInterval(async () => {
    try {
      const res = await client.call<{ calls: any[] }>("list_calls", {});
      const calls = res.calls ?? [];
      const seen = new Set<string>();
      for (const c of calls) {
        seen.add(c.call_id);
        const prev = lastState.get(c.call_id);
        const cur = { state: c.state, floor: c.floor };
        lastState.set(c.call_id, cur);
        // CRITICAL: only emit connected/ended for calls THIS session owns.
        // A call is "owned" if THIS session's user either accepted the invite
        // (peer_accept_invite) OR initiated the call via peer_invite. We track
        // that via ownedByThisSession. Without this check, every concurrent
        // claude session on the machine would receive its own connected event
        // and race to peer_recv — burning tokens and double-reading.
        if (!ownedByThisSession.has(c.call_id)) {
          continue;
        }
        // Emit a "connected" event the moment a call flips into CONNECTED.
        if (prev?.state !== "CONNECTED" && cur.state === "CONNECTED") {
          emitChannel(server, {
            kind: "connected",
            call_id: c.call_id,
            remote_peer: c.remote_peer,
            floor: c.floor,
            content:
              `Peer call ${c.call_id} with ${c.remote_peer} is now connected.\n` +
              `Floor: ${c.floor} (you are ${c.is_local_caller ? "the caller" : "the callee"}).\n\n` +
              `Call mcp__peerd__peer_recv with this call_id IMMEDIATELY to receive the next message, then reason and call peer_send to reply. Continue the recv/send loop until either side calls peer_end.`,
          });
        }
        // Emit "ended" once.
        if (prev && prev.state !== "CLOSED" && cur.state === "CLOSED") {
          emitChannel(server, {
            kind: "ended",
            call_id: c.call_id,
            remote_peer: c.remote_peer,
            content:
              `Peer call ${c.call_id} with ${c.remote_peer} has ended. Briefly summarize what was agreed for the user (if you have that context) and otherwise return to standby.`,
          });
        }
      }
      // Garbage-collect calls that disappeared.
      for (const id of Array.from(lastState.keys())) {
        if (!seen.has(id)) lastState.delete(id);
      }
    } catch {
      // peerd may briefly be unreachable; ignore.
    }
  }, 1000).unref();
}

function emitChannel(
  server: McpServer,
  evt: { kind: string; call_id?: string; content: string; [k: string]: unknown },
): void {
  const meta: Record<string, string> = { kind: evt.kind };
  for (const [k, v] of Object.entries(evt)) {
    if (k === "kind" || k === "content") continue;
    if (typeof v === "string" && /^[A-Za-z0-9_]+$/.test(k)) meta[k] = v;
  }
  const params = { content: evt.content, meta };
  console.error(`[peer-mcp] channel: ${evt.kind} ${JSON.stringify(meta)}`);
  // Send arbitrary JSON-RPC notification to the connected client (Claude Code).
  // Uses the lower-level Protocol.notification() method on McpServer.server.
  const notif = { method: "notifications/claude/channel", params } as any;
  void (server.server as any).notification(notif).catch?.((e: any) => {
    console.error(`[peer-mcp] channel emit error: ${e?.message ?? e}`);
  });
}

main().catch((err) => {
  console.error("[peer-mcp] fatal:", err);
  process.exit(1);
});
