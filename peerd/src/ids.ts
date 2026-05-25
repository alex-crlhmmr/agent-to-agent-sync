import { ulid } from "ulidx";

export const callId = () => `c_${ulid()}`;
export const voicemailId = () => `vm_${ulid()}`;
export const refId = () => `ref_${ulid()}`;
export const sessionToken = () => `sk_call_${ulid()}`;

export const nowIso = () => new Date().toISOString();

export function randomNonce(): string {
  return ulid();
}
