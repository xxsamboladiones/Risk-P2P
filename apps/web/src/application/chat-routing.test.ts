import { describe, expect, it } from "vitest";
import { callOwnsTextConversation } from "./chat-routing";

describe("roteamento do chat entre o menu e a chamada", () => {
  it("compartilha a sessão da chamada quando as duas telas exibem o mesmo canal", () => {
    expect(callOwnsTextConversation({
      roomId: "voice-room",
      conversationId: "general-text",
      callTextChannelId: "general-text",
      privateConversation: false,
    })).toBe(true);
  });

  it("mantém a sessão normal para outro canal ou uma conversa privada", () => {
    expect(callOwnsTextConversation({
      roomId: "voice-room",
      conversationId: "outro-canal",
      callTextChannelId: "general-text",
      privateConversation: false,
    })).toBe(false);
    expect(callOwnsTextConversation({
      roomId: "voice-room",
      conversationId: "general-text",
      callTextChannelId: "general-text",
      privateConversation: true,
    })).toBe(false);
  });

  it("devolve o canal ao chat normal quando a chamada termina", () => {
    expect(callOwnsTextConversation({
      roomId: null,
      conversationId: "general-text",
      callTextChannelId: "general-text",
      privateConversation: false,
    })).toBe(false);
  });
});
