export const RISK_APP_VERSION = import.meta.env.VITE_RISK_APP_VERSION ?? "0.2.1";
export const RISK_CALL_PROTOCOL_VERSION = 2;
export const RISK_CHAT_PROTOCOL_VERSION = 2;
export const RISK_GROUP_MANIFEST_VERSION = 2;

export type RiskPeerCapabilities = {
  appVersion: string;
  callProtocolVersion: number;
  chatProtocolVersion: number;
  groupManifestVersion: number;
};

export const LOCAL_RISK_CAPABILITIES: RiskPeerCapabilities = {
  appVersion: RISK_APP_VERSION,
  callProtocolVersion: RISK_CALL_PROTOCOL_VERSION,
  chatProtocolVersion: RISK_CHAT_PROTOCOL_VERSION,
  groupManifestVersion: RISK_GROUP_MANIFEST_VERSION,
};

export function compatibleAppVersion(version: string | undefined): boolean {
  if (!version) return false;
  const local = RISK_APP_VERSION.split(".");
  const remote = version.split(".");
  return local.length >= 2 && remote.length >= 2 && local[0] === remote[0] && local[1] === remote[1];
}

export function validRiskPeerCapabilities(value: unknown): value is RiskPeerCapabilities {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<RiskPeerCapabilities>;
  return typeof item.appVersion === "string"
    && item.appVersion.length >= 3
    && item.appVersion.length <= 32
    && Number.isSafeInteger(item.callProtocolVersion)
    && Number.isSafeInteger(item.chatProtocolVersion)
    && Number.isSafeInteger(item.groupManifestVersion);
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
