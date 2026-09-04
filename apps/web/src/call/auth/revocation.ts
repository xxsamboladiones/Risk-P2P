import {
  validGroupRevocationCertificate,
  type GroupRevocationCertificate,
} from "../../services/offline/social-storage";

export type CallGroupRevocationMessage = {
  version: 1;
  type: "call.group.revocation";
  certificate: GroupRevocationCertificate;
};

export function parseCallGroupRevocationMessage(raw: string): CallGroupRevocationMessage | null {
  if (new TextEncoder().encode(raw).byteLength > 64 * 1024) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const message = value as Partial<CallGroupRevocationMessage>;
  if (message.version !== 1 || message.type !== "call.group.revocation" || !validGroupRevocationCertificate(message.certificate)) return null;
  return message as CallGroupRevocationMessage;
}

export function callGroupRevocationMessage(certificate: GroupRevocationCertificate): CallGroupRevocationMessage {
  return { version: 1, type: "call.group.revocation", certificate };
}
