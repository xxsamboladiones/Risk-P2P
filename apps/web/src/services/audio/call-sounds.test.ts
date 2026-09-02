import { describe, expect, it } from "vitest";
import { CALL_SOUND_SOURCES, callSoundForRoomTransition } from "./call-sounds";

describe("sons da chamada", () => {
  it("usa os arquivos OGG públicos empacotados pelo Vite", () => {
    expect(CALL_SOUND_SOURCES).toEqual({
      connect: "./audio/call/connect.ogg",
      disconnect: "./audio/call/disconnect.ogg",
    });
  });

  it("toca conexão somente ao entrar ou trocar de sala", () => {
    expect(callSoundForRoomTransition(null, "room-a")).toBe("connect");
    expect(callSoundForRoomTransition("room-a", "room-b")).toBe("connect");
    expect(callSoundForRoomTransition("room-a", "room-a")).toBeNull();
  });

  it("toca desconexão somente ao sair da sala", () => {
    expect(callSoundForRoomTransition("room-a", null)).toBe("disconnect");
    expect(callSoundForRoomTransition(null, null)).toBeNull();
  });
});
