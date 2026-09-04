import { describe, expect, it } from "vitest";
import type { LocalIdentity } from "../../services/offline/social-storage";
import { AuthenticationManager, sameCallPublicKey } from "./AuthenticationManager";

describe("AuthenticationManager", () => {
  it("cria e reconhece desafios compatíveis", () => {
    const manager = new AuthenticationManager();
    const challenge = manager.createChallenge("00000000-0000-4000-8000-000000000001");
    expect(manager.parse(JSON.stringify(challenge))).toMatchObject({
      status: "valid",
      message: { type: "call.auth.challenge", identityPeerId: "00000000-0000-4000-8000-000000000001" },
    });
  });

  it("assina e verifica uma prova ECDSA bilateral", async () => {
    const manager = new AuthenticationManager();
    const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const remotePeerId = "00000000-0000-4000-8000-000000000002";
    const localPeerId = "00000000-0000-4000-8000-000000000001";
    const identity: LocalIdentity = {
      id: "self",
      peerId: remotePeerId,
      displayName: "Peer remoto",
      publicKey: await crypto.subtle.exportKey("jwk", keys.publicKey),
      privateKey: keys.privateKey,
    };
    const proof = await manager.createProof(identity, {
      roomId: "room-auth",
      localPeerId: remotePeerId,
      remotePeerId: localPeerId,
    }, "nonce-auth");

    await expect(manager.verifyProof(
      identity,
      proof.identity,
      { roomId: "room-auth", localPeerId, remotePeerId },
      proof.nonce,
      proof.capabilities,
      proof.signature,
    )).resolves.toBe(true);
    expect(manager.validRemoteIdentity(remotePeerId, proof.identity)).toBe(true);
  });

  it("compara somente os componentes públicos relevantes da chave", () => {
    expect(sameCallPublicKey(
      { kty: "EC", crv: "P-256", x: "x", y: "y", ext: true },
      { y: "y", x: "x", crv: "P-256", kty: "EC", key_ops: ["verify"] },
    )).toBe(true);
  });
});
