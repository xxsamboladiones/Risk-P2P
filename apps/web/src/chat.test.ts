import { describe, expect, it } from "vitest";
import { canonicalChatEvent, parseChatWireEnvelope, parseChatWireMessage, privateConversationId } from "./chat";
import { projectMessage } from "./chat/MessageService";

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

describe("eventos assinados do chat", () => {
  const baseEvent = {
    version: 3 as const,
    type: "chat.event" as const,
    channelId: "channel-a",
    id: "00000000-0000-4000-8000-000000000010",
    targetMessageId: "00000000-0000-4000-8000-000000000002",
    actorPeerId: "00000000-0000-4000-8000-000000000003",
    action: "edit" as const,
    content: "Texto corrigido",
    timestamp: Date.now(),
    signature: "B".repeat(86),
  };

  it("aceita edição v3 e produz uma assinatura canônica estável", () => {
    expect(parseChatWireEnvelope(JSON.stringify(baseEvent), "channel-a")).toEqual(baseEvent);
    expect(canonicalChatEvent(baseEvent)).toContain('"action":"edit"');
  });

  it("recusa payloads que não correspondem à ação", () => {
    expect(parseChatWireEnvelope(JSON.stringify({ ...baseEvent, action: "delete", content: "não permitido" }), "channel-a")).toBeNull();
    expect(parseChatWireEnvelope(JSON.stringify({ ...baseEvent, action: "reaction.add", content: undefined, emoji: "" }), "channel-a")).toBeNull();
  });

  it("projeta resposta, edição, reação, fixação e exclusão sem alterar a mensagem assinada", () => {
    const message = {
      id: baseEvent.targetMessageId,
      channelId: "channel-a",
      author: "Maria",
      authorPeerId: baseEvent.actorPeerId,
      content: "Texto original",
      createdAt: new Date(baseEvent.timestamp - 1_000).toISOString(),
      signature: "A".repeat(86),
    };
    const projected = projectMessage(message, [
      baseEvent,
      { ...baseEvent, id: "00000000-0000-4000-8000-000000000011", action: "reply", content: undefined, referenceMessageId: "00000000-0000-4000-8000-000000000099", timestamp: baseEvent.timestamp + 1 },
      { ...baseEvent, id: "00000000-0000-4000-8000-000000000012", action: "reaction.add", content: undefined, emoji: "👍", timestamp: baseEvent.timestamp + 2 },
      { ...baseEvent, id: "00000000-0000-4000-8000-000000000013", action: "pin", content: undefined, timestamp: baseEvent.timestamp + 3 },
      { ...baseEvent, id: "00000000-0000-4000-8000-000000000014", action: "delete", content: undefined, timestamp: baseEvent.timestamp + 4 },
    ]);
    expect(projected.content).toBe("Texto original");
    expect(projected.editedContent).toBe("Texto corrigido");
    expect(projected.replyToId).toBe("00000000-0000-4000-8000-000000000099");
    expect(projected.reactions).toEqual({ "👍": [baseEvent.actorPeerId] });
    expect(projected.pinnedAt).toBeTruthy();
    expect(projected.deletedAt).toBeTruthy();
  });
});
