import {
  Envelope,
  ErrorCode,
  ErrorPayload,
  MessageType,
  PROTOCOL_VERSION,
} from "./types.js";
import { nowIso } from "./ids.js";

// 16 MiB — comfortably above SHARE_FILE_REF_MAX_BYTES (10 MiB) + JSON envelope
// overhead. The PROTOCOL.md §2 originally said 1 MiB before we lifted the
// share_file_ref cap; raised here to keep the wire usable for large refs.
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

export function encode<T>(env: Envelope<T>): string {
  return JSON.stringify(env);
}

export class WireError extends Error {
  constructor(public code: string, message: string, public details?: Record<string, unknown>) {
    super(message);
  }
}

export function decode(raw: string): Envelope {
  if (raw.length > MAX_FRAME_BYTES) {
    throw new WireError(ErrorCode.MESSAGE_TOO_LARGE, `frame ${raw.length} > ${MAX_FRAME_BYTES} bytes`);
  }
  let obj: any;
  try {
    obj = JSON.parse(raw);
  } catch (e: any) {
    throw new WireError(ErrorCode.INVALID_MESSAGE, `not JSON: ${e?.message ?? e}`);
  }
  if (typeof obj !== "object" || obj === null) {
    throw new WireError(ErrorCode.INVALID_MESSAGE, "envelope is not an object");
  }
  if (obj.v !== PROTOCOL_VERSION) {
    throw new WireError(ErrorCode.UNSUPPORTED_VERSION, `v=${obj.v}`);
  }
  if (typeof obj.type !== "string") {
    throw new WireError(ErrorCode.INVALID_MESSAGE, "missing type");
  }
  if (typeof obj.from !== "string") {
    throw new WireError(ErrorCode.INVALID_MESSAGE, "missing from");
  }
  if (typeof obj.ts !== "string") {
    throw new WireError(ErrorCode.INVALID_MESSAGE, "missing ts");
  }
  if (obj.payload === undefined || obj.payload === null) {
    obj.payload = {};
  }
  return obj as Envelope;
}

export function envelope<T>(
  type: MessageType,
  from: string,
  payload: T,
  opts: { call_id?: string; seq?: number } = {},
): Envelope<T> {
  return {
    v: PROTOCOL_VERSION,
    type,
    ts: nowIso(),
    from,
    call_id: opts.call_id,
    seq: opts.seq,
    payload,
  };
}

export function errorEnvelope(
  from: string,
  code: string,
  message: string,
  opts: { call_id?: string; in_response_to_seq?: number; details?: Record<string, unknown> } = {},
): Envelope<ErrorPayload> {
  return envelope<ErrorPayload>("ERROR", from, {
    code,
    message,
    in_response_to_seq: opts.in_response_to_seq,
    in_response_to_call: opts.call_id,
    details: opts.details,
  }, { call_id: opts.call_id });
}
