import { describe, expect, it } from "vitest";
import { parseChatWireMessage, privateConversationId } from "./chat";

function message(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    version: 1, type: "chat.message", channelId: "channel-a",
    id: "00000000-0000-4000-8000-000000000001", author: "Maria",
    content: "Olá pelo WebRTC", timestamp: Date.now(), ...overrides,
  });
}

function signedMessage(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    version: 2, type: "chat.message", channelId: "channel-a",
    id: "00000000-0000-4000-8000-000000000002",
    authorPeerId: "00000000-0000-4000-8000-000000000003",
    author: "Maria", content: "Mensagem assinada", timestamp: Date.now(),
    signature: "A".repeat(86), ...overrides,
  });
}

describe("mensagens do chat P2P", () => {
  it("aceita uma mensagem legada válida do canal conectado", () => {
    expect(parseChatWireMessage(message(), "channel-a")).toEqual(expect.objectContaining({ author: "Maria", content: "Olá pelo WebRTC" }));
  });

  it("aceita o envelope v2 assinado antes da verificação criptográfica", () => {
    expect(parseChatWireMessage(signedMessage(), "channel-a")).toEqual(expect.objectContaining({
      version: 2,
      authorPeerId: "00000000-0000-4000-8000-000000000003",
      signature: "A".repeat(86),
    }));
  });

  it("ignora outro canal, mensagens antigas e conteúdo excessivo", () => {
    expect(parseChatWireMessage(message(), "channel-b")).toBeNull();
    expect(parseChatWireMessage(message({ timestamp: Date.now() - 121_000 }), "channel-a")).toBeNull();
    expect(parseChatWireMessage(message({ content: "x".repeat(4_001) }), "channel-a")).toBeNull();
    expect(parseChatWireMessage(signedMessage({ signature: "invalida" }), "channel-a")).toBeNull();
  });
});

describe("identificador de conversa privada", () => {
  it("é determinístico independentemente de quem inicia", async () => {
    const a = "00000000-0000-4000-8000-000000000010";
    const b = "00000000-0000-4000-8000-000000000020";
    const [ab, ba] = await Promise.all([privateConversationId(a, b), privateConversationId(b, a)]);
    expect(ab).toBe(ba);
    expect(ab).toMatch(/^dm-[0-9a-f]{64}$/);
  });
});
