// Wire protocol types per PROTOCOL.md §5.
// Strict subset for M1: HELLO/WELCOME/PING/PONG/INVITE/INVITE_RESPONSE/SEND/END/HUMAN_INJECT/ERROR/DISCONNECT/RESUME.

export const PROTOCOL_VERSION = 1;
export const PEER_VERSION = "0.1.0";

export type MessageType =
  | "HELLO"
  | "WELCOME"
  | "PING"
  | "PONG"
  | "INVITE"
  | "INVITE_RESPONSE"
  | "SEND"
  | "SHARE_FILE"
  | "SHARE_FILE_REF"
  | "FETCH"
  | "FETCH_RESPONSE"
  | "PROPOSE_CHANGE"
  | "PAUSE"
  | "RESUME"
  | "END"
  | "HUMAN_INJECT"
  | "ERROR"
  | "DISCONNECT"
  | "RESUME"
  | "LIST_SESSIONS"
  | "LIST_SESSIONS_RESPONSE";

export interface Envelope<T = unknown> {
  v: 1;
  type: MessageType;
  ts: string;
  from: string;
  call_id?: string;
  seq?: number;
  payload: T;
}

export interface HelloPayload {
  peer_version: string;
  capabilities: string[];
  advertised_name?: string;
  supported_protocol_versions: number[];
}

export interface WelcomePayload {
  peer_version: string;
  capabilities: string[];
  protocol_version: number;
  server_time: string;
}

export interface PingPayload { nonce: string; }
export interface PongPayload { nonce: string; }

export interface InvitePayload {
  topic: string;
  caller_label: string;
  expires_at?: string;
  first_floor?: "caller" | "callee";
  suggested_artifacts?: string[];
  context_excerpt?: string;
  /** Optional: target a specific subscriber on the callee side (from list_remote_sessions). */
  target_subscriber_id?: string;
}

export interface InviteResponsePayload {
  accepted: boolean;
  reason?: string;
  session_token?: string;
}

export interface SendPayload { text: string; }

/** Inline-file share — content carried directly. Hard cap 256 KiB per PROTOCOL.md §5.5.2. */
export interface ShareFilePayload {
  path: string;
  content: string;
  language?: string;
  reason?: string;
  hash_sha256: string;
}

/** Cross-side change proposal: "I propose YOUR side change like this." */
export interface ProposeChangePayload {
  target_file: string;
  diff: string;
  rationale: string;
  /** Default true. If true, receiver should NOT apply without human OK. */
  requires_human_approval?: boolean;
  tests_added?: Array<{ path: string; diff: string }>;
}

/** Hard cap on inline file content (per PROTOCOL.md §5.5.2). */
export const SHARE_FILE_MAX_BYTES = 256 * 1024;

/** Hard cap on share_file_ref content (10 MiB). Bigger needs real streaming. */
export const SHARE_FILE_REF_MAX_BYTES = 10 * 1024 * 1024;

/** Reference-share: full content stays on sender; receiver pulls via FETCH. */
export interface ShareFileRefPayload {
  ref: string;
  path: string;
  size_bytes: number;
  hash_sha256: string;
  preview?: string;
  preview_lines?: string;
  reason?: string;
  language?: string;
}

export interface FetchPayload {
  request_id: string;
  ref: string;
}

export interface FetchResponsePayload {
  request_id: string;
  ref: string;
  ok: boolean;
  /** Present iff ok=true. */
  content?: string;
  hash_sha256?: string;
  /** Present iff ok=false. */
  reason?: string;
}

export interface PausePayload {
  reason?: string;
  eta_seconds?: number;
}

/** Note: distinct from the connection-level RESUME (reconnect-with-replay).
 *  This is the in-call pause/resume mechanic. */
export interface ResumeCallPayload {
  /** Empty placeholder for future expansion. */
  noop?: never;
}

export interface EndPayload {
  reason:
    | "agreement_reached"
    | "human_takeover"
    | "no_agreement"
    | "timeout"
    | "error"
    | "decline";
  agreement?: {
    summary?: string;
    decisions?: Array<{ topic: string; decision: string }>;
  };
  action_items?: Array<{ owner: string; task: string; due?: string }>;
  artifacts?: Array<{ kind: string; path: string }>;
}

export interface HumanInjectPayload {
  tag: string;
  text: string;
  priority?: "override" | "advisory";
}

export interface ErrorPayload {
  code: string;
  message: string;
  in_response_to_seq?: number;
  in_response_to_call?: string;
  details?: Record<string, unknown>;
}

export interface DisconnectPayload { reason?: string; }

export interface ListSessionsPayload {
  request_id: string;
}

export interface SessionInfo {
  id: string;
  label?: string;
  cwd?: string;
  /** ISO timestamp when the subscriber connected. */
  subscribed_at: string;
}

export interface ListSessionsResponsePayload {
  request_id: string;
  sessions: SessionInfo[];
}

export interface ResumePayload {
  call_id: string;
  last_seq_received: number;
}

// Error code registry (PROTOCOL.md §6)
export const ErrorCode = {
  AUTH_FAILED: "AUTH_FAILED",
  UNSUPPORTED_VERSION: "UNSUPPORTED_VERSION",
  UNKNOWN_PEER: "UNKNOWN_PEER",
  INVALID_MESSAGE: "INVALID_MESSAGE",
  MESSAGE_TOO_LARGE: "MESSAGE_TOO_LARGE",
  UNKNOWN_CALL: "UNKNOWN_CALL",
  CALL_CLOSED: "CALL_CLOSED",
  OUT_OF_TURN: "OUT_OF_TURN",
  INVITE_TIMEOUT: "INVITE_TIMEOUT",
  INVITE_DECLINED: "INVITE_DECLINED",
  PEER_UNREACHABLE: "PEER_UNREACHABLE",
  RESUME_EXPIRED: "RESUME_EXPIRED",
  REF_UNAVAILABLE: "REF_UNAVAILABLE",
  RATE_LIMITED: "RATE_LIMITED",
  INTERNAL_ERROR: "INTERNAL_ERROR",
  /** No subscribers on the remote peerd are available (opted-in). */
  NO_AVAILABLE_SESSIONS: "NO_AVAILABLE_SESSIONS",
  /** Target session was specified but doesn't exist or is no longer available. */
  NO_SUCH_SESSION: "NO_SUCH_SESSION",
} as const;
export type ErrorCodeT = (typeof ErrorCode)[keyof typeof ErrorCode];

// Capability registry (PROTOCOL.md §9)
export const Capability = {
  SHARE_FILE: "share_file",
  PROPOSE_CHANGE: "propose_change",
  VOICEMAIL: "voicemail",
  FETCH: "fetch",
  PAUSE_RESUME: "pause_resume",
  HUMAN_INJECT: "human_inject",
} as const;

// What this M1 build advertises. SEND/END/HUMAN_INJECT are mandatory and not flagged.
export const M1_CAPABILITIES: string[] = [Capability.HUMAN_INJECT];

// Call-state types (in-memory; mirrors PROTOCOL.md §4)
export type CallState =
  | "IDLE"
  | "DIALING"
  | "RINGING"
  | "CONNECTED"
  | "PAUSED"
  | "CLOSING"
  | "CLOSED";

export type Floor = "caller" | "callee" | "none";

export interface CallRecord {
  call_id: string;
  state: CallState;
  topic: string;
  caller: string;
  callee: string;
  isLocalCaller: boolean;
  floor: Floor;
  seqOut: number;
  seqIn: number;
  sessionToken?: string;
  startedAt: string;
  endedAt?: string;
  capabilities: string[];
  transcriptPath: string;
  remotePeerName: string;
}
