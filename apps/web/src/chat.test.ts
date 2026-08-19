import { describe, expect, it } from "vitest";
import { parseChatWireMessage } from "./chat";

function message(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    version: 1, type: "chat.message", channelId: "channel-a",
    id: "00000000-0000-4000-8000-000000000001", author: "Maria",
    content: "Olá pelo WebRTC", timestamp: Date.now(), ...overrides,
  });
}

describe("mensagens do chat P2P", () => {
  it("aceita uma mensagem válida do canal conectado", () => {
    expect(parseChatWireMessage(message(), "channel-a")).toEqual(expect.objectContaining({ author: "Maria", content: "Olá pelo WebRTC" }));
  });
  it("ignora outro canal, mensagens antigas e conteúdo excessivo", () => {
    expect(parseChatWireMessage(message(), "channel-b")).toBeNull();
    expect(parseChatWireMessage(message({ timestamp: Date.now() - 121_000 }), "channel-a")).toBeNull();
    expect(parseChatWireMessage(message({ content: "x".repeat(4_001) }), "channel-a")).toBeNull();
  });
});
