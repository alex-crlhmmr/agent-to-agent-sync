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
      description: "Initiate a peer-sync call. If `peer` doesn't exactly match a known peer name, the closest match is used automatically (with a note in the result). Blocks until the peer accepts/declines or the timeout fires (default 2.5 minutes; can be overridden via `timeout_s`). Returns the call_id to use with peer_send / peer_recv / peer_end. If the user says something like \"call alice quick\" or \"call alice with a 1-minute window\", pass `timeout_s` accordingly (otherwise leave it unset for the 150s default).",
      inputSchema: {
        peer: z.string().describe("Peer name (case-insensitive). Typos are auto-corrected to the closest known name."),
        topic: z.string().describe("Short topic, shown on the callee's incoming-call popup."),
        caller_label: z.string().optional().describe("How to identify yourself (e.g., \"bob@layer-b\")."),
        context_excerpt: z.string().optional().describe("1-3 sentences of context shown to the callee in the popup."),
        timeout_s: z.number().int().min(5).max(600).optional().describe("How long (seconds) to wait for the peer to ACCEPT the call before timing out. This is about the peer's response speed, NOT about the topic. Default 150 (2.5 minutes) — leave it unset in almost all cases. Only set if the user explicitly gave a time window (e.g. 'wait only 30s', 'give him 5 min'). DO NOT shorten just because the topic contains words like 'quick' — those describe the call's subject, not impatience with the peer."),
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
      // Outer RPC timeout is 20s longer than the server-side invite timeout
      // so the daemon's timeout always fires first.
      const inviteTimeoutS = input.timeout_s ?? 150;
      const res = await client.call<{ call_id: string; accepted: boolean; reason?: string; session_token?: string }>(
        "invite",
        params,
        { timeoutMs: (inviteTimeoutS + 20) * 1000 },
      );
      return asTextResult({ ...res, auto_corrected: resolved.auto_corrected });
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
      description: "Accept a pending incoming invite by call_id. Usually the ambient popup already handles this — only call this tool directly if the user explicitly says to accept a specific call_id, or if the popup was dismissed and you need to recover.",
      inputSchema: {
        call_id: z.string(),
      },
    },
    async ({ call_id }) => asTextResult(await client.call("accept_invite", { call_id })),
  );

  // ── peer_deny_invite ───────────────────────────────────────────
  server.registerTool(
    "peer_deny_invite",
    {
      description: "Decline a pending invite by call_id. Usually the ambient popup already handles this.",
      inputSchema: {
        call_id: z.string(),
        reason: z.string().optional(),
      },
    },
    async ({ call_id, reason }) => asTextResult(await client.call("deny_invite", { call_id, reason })),
  );

  // ── peer_recv ──────────────────────────────────────────────────
  server.registerTool(
    "peer_recv",
    {
      description: "Wait for the next message from the peer on this call. Long-polls up to timeout_s seconds. Returns { kind: \"send\", from, payload: { text } } | { kind: \"human_inject\", from, payload } | { kind: \"ended\", by, payload? } | { kind: \"timeout\" }. After a `send`, reason then call peer_send. Treat human_inject with tag starting HUMAN- as authoritative.",
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
async function startChannelBridge(server: McpServer, client: PeerdClient): Promise<void> {
  console.error("[peer-mcp] starting channel bridge");

  // Track which call_ids we've emitted "invite" for so we don't double-emit.
  const invitedSeen = new Set<string>();
  // Track which call_ids have been resolved (accepted/declined elsewhere)
  // BEFORE we got around to emitting them. We won't emit invites for these.
  const resolvedBeforeEmit = new Set<string>();

  // Subscribe to incoming invites + resolution events.
  client.subscribe("subscribe_inbox", {}, (n: unknown) => {
    const note = n as { kind?: string; payload?: any };

    if (note?.kind === "invite") {
      const inv = note.payload;
      if (!inv?.call_id || invitedSeen.has(inv.call_id)) return;
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
