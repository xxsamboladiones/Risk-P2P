import { describe, expect, it } from "vitest";
import { CallSession } from "./CallSession";

describe("CallSession", () => {
  it("invalida operações assíncronas de uma sessão anterior", () => {
    const session = new CallSession();
    const first = session.begin("room-a", "peer-a", "rendezvous-a");
    expect(session.isActive(first, true)).toBe(true);

    const second = session.begin("room-b", "peer-b", "rendezvous-b");
    expect(session.isActive(first, true)).toBe(false);
    expect(session.isActive(second, true)).toBe(true);
    expect(session).toMatchObject({ roomId: "room-b", peerId: "peer-b", rendezvousId: "rendezvous-b" });

    session.end();
    expect(session.isActive(second, true)).toBe(false);
    expect(session).toMatchObject({ roomId: undefined, peerId: undefined, rendezvousId: undefined });
  });
});
