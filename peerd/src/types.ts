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
  | "END"
  | "HUMAN_INJECT"
  | "ERROR"
  | "DISCONNECT"
  | "RESUME";

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
}

export interface InviteResponsePayload {
  accepted: boolean;
  reason?: string;
  session_token?: string;
}

export interface SendPayload { text: string; }

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
