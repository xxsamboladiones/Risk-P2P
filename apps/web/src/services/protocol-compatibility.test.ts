import { describe, expect, it } from "vitest";
import {
  compatibleAppVersion,
  compatibleCallPeer,
  compatibleChatPeer,
  LOCAL_RISK_CAPABILITIES,
  validRiskPeerCapabilities,
} from "./protocol-compatibility";

describe("negociação de versão P2P", () => {
  it("aceita a versão e os protocolos locais", () => {
    expect(compatibleAppVersion(LOCAL_RISK_CAPABILITIES.appVersion)).toBe(true);
    expect(compatibleCallPeer(LOCAL_RISK_CAPABILITIES)).toBe(true);
    expect(compatibleChatPeer(LOCAL_RISK_CAPABILITIES)).toBe(true);
  });

  it("recusa versões ou protocolos incompatíveis antes da mídia", () => {
    expect(compatibleAppVersion("99.0.0")).toBe(false);
    expect(compatibleCallPeer({ ...LOCAL_RISK_CAPABILITIES, callProtocolVersion: 1 })).toBe(false);
    expect(compatibleChatPeer({ ...LOCAL_RISK_CAPABILITIES, chatProtocolVersion: 1 })).toBe(false);
    expect(compatibleChatPeer({ ...LOCAL_RISK_CAPABILITIES, groupManifestVersion: 1 })).toBe(false);
  });

  it("valida envelopes sem aceitar campos ausentes", () => {
    expect(validRiskPeerCapabilities(LOCAL_RISK_CAPABILITIES)).toBe(true);
    expect(validRiskPeerCapabilities({ appVersion: "0.2.0" })).toBe(false);
    expect(validRiskPeerCapabilities(null)).toBe(false);
  });
});
