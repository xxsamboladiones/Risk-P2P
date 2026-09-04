export const RISK_APP_VERSION = import.meta.env.VITE_RISK_APP_VERSION ?? "0.2.1";
export const RISK_NEGOTIATION_PROTOCOL_VERSION = 2;
export const RISK_CALL_PROTOCOL_VERSION = 2;
export const RISK_CHAT_PROTOCOL_VERSION = 2;
export const RISK_GROUP_MANIFEST_VERSION = 2;

export const RISK_CAPABILITIES = [
  "files-v2",
  "screen-audio",
  "rnnoise",
  "group-sync-v2",
  "chat-events-v1",
  "chat-replies-v1",
  "message-edit-v1",
  "message-delete-v1",
  "message-reactions-v1",
  "message-pins-v1",
  "typing-indicator-v1",
  "markdown-safe-links-v1",
] as const;

export type RiskCapability = typeof RISK_CAPABILITIES[number];

export type RiskPeerCapabilities = {
  appVersion: string;
  callProtocolVersion: number;
  chatProtocolVersion: number;
  groupManifestVersion: number;
  /** Envelope novo; os campos acima continuam presentes para clientes 0.2.x. */
  protocol?: number;
  client?: string;
  capabilities?: string[];
};

export const LOCAL_RISK_CAPABILITIES: RiskPeerCapabilities = {
  appVersion: RISK_APP_VERSION,
  callProtocolVersion: RISK_CALL_PROTOCOL_VERSION,
  chatProtocolVersion: RISK_CHAT_PROTOCOL_VERSION,
  groupManifestVersion: RISK_GROUP_MANIFEST_VERSION,
  protocol: RISK_NEGOTIATION_PROTOCOL_VERSION,
  client: RISK_APP_VERSION,
  capabilities: [...RISK_CAPABILITIES],
};

export function compatibleAppVersion(version: string | undefined): boolean {
  if (!version) return false;
  const local = RISK_APP_VERSION.split(".");
  const remote = version.split(".");
  // Funcionalidades são negociadas abaixo. A versão do app só bloqueia uma
  // geração principal diferente, permitindo, por exemplo, Risk 0.3 <-> 0.4.
  return validSemver(version) && validSemver(RISK_APP_VERSION) && local[0] === remote[0];
}

export function validRiskPeerCapabilities(value: unknown): value is RiskPeerCapabilities {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<RiskPeerCapabilities>;
  return typeof item.appVersion === "string"
    && validSemver(item.appVersion)
    && Number.isSafeInteger(item.callProtocolVersion)
    && Number.isSafeInteger(item.chatProtocolVersion)
    && Number.isSafeInteger(item.groupManifestVersion)
    && (item.protocol === undefined || (Number.isSafeInteger(item.protocol) && Number(item.protocol) >= 1 && Number(item.protocol) <= 32))
    && (item.client === undefined || (item.client === item.appVersion && validSemver(item.client)))
    && (item.capabilities === undefined || (
      Array.isArray(item.capabilities)
      && item.capabilities.length <= 64
      && item.capabilities.every((capability) => typeof capability === "string" && /^[a-z0-9][a-z0-9-]{1,63}$/.test(capability))
    ));
}

export function compatibleCallPeer(capabilities: RiskPeerCapabilities): boolean {
  return compatibleAppVersion(capabilities.appVersion)
    && capabilities.callProtocolVersion === RISK_CALL_PROTOCOL_VERSION
    && capabilities.groupManifestVersion === RISK_GROUP_MANIFEST_VERSION;
}

export function compatibleChatPeer(capabilities: RiskPeerCapabilities): boolean {
  return compatibleAppVersion(capabilities.appVersion)
    && capabilities.chatProtocolVersion === RISK_CHAT_PROTOCOL_VERSION
    && capabilities.groupManifestVersion === RISK_GROUP_MANIFEST_VERSION;
}

export function incompatiblePeerMessage(remoteVersion?: string): string {
  return `Este peer usa Risk ${remoteVersion || "anterior"}, incompatível com ${RISK_APP_VERSION}. Atualize o Risk nos dois dispositivos.`;
}

export function peerSupportsCapability(capabilities: RiskPeerCapabilities | undefined, capability: RiskCapability): boolean {
  return capabilities?.capabilities?.includes(capability) === true;
}

export function negotiateCapabilities(remote: RiskPeerCapabilities): RiskCapability[] {
  const supported = new Set(remote.capabilities ?? []);
  return RISK_CAPABILITIES.filter((capability) => supported.has(capability));
}

function validSemver(version: string): boolean {
  return version.length >= 3 && version.length <= 32 && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version);
}
