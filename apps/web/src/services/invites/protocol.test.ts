import { describe, expect, it } from "vitest";
import type { LocalIdentity } from "../offline/social-storage";
import { createSignedInviteMessage, parseAndVerifyInviteMessage } from "./protocol";

async function identity(name: string): Promise<LocalIdentity> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  return { id: "self", peerId: crypto.randomUUID(), displayName: name, publicKey: await crypto.subtle.exportKey("jwk", pair.publicKey), privateKey: pair.privateKey };
}

describe("protocolo assinado de convites", () => {
  it("assina e valida um pedido de amizade", async () => {
    const author = await identity("Maria"); const now = Date.now();
    const message = await createSignedInviteMessage(author, { type: "friend.request", requestId: crypto.randomUUID(), timestamp: now });
    const parsed = await parseAndVerifyInviteMessage(JSON.stringify(message), now);
    expect(parsed?.identity.displayName).toBe("Maria"); expect(parsed?.type).toBe("friend.request");
  });

  it("rejeita adulteração, mensagens antigas e payload excessivo", async () => {
    const author = await identity("João"); const now = Date.now();
    const message = await createSignedInviteMessage(author, { type: "group.join.request", requestId: crypto.randomUUID(), timestamp: now });
    expect(await parseAndVerifyInviteMessage(JSON.stringify({ ...message, identity: { ...message.identity, displayName: "Invasor" } }), now)).toBeNull();
    expect(await parseAndVerifyInviteMessage(JSON.stringify(message), now + 180_000)).toBeNull();
    expect(await parseAndVerifyInviteMessage(`{"padding":"${"x".repeat(50_000)}"}`, now)).toBeNull();
  });
});
