import { describe, expect, it } from "vitest";
import { assertLocalGroupSyncBudget, type LocalGroup } from "./social-storage";

const identity = {
  peerId: "peer_12345678",
  displayName: "Samuel",
  publicKey: { kty: "EC", crv: "P-256", x: "A".repeat(43), y: "B".repeat(43) },
};

function group(avatar?: string): LocalGroup {
  return {
    groupId: "group_12345678",
    name: "Grupo",
    avatar,
    channels: [{ id: "channel_12345678", name: "geral", kind: "text" }],
    ownerPeerId: identity.peerId,
    membershipVersion: 1,
    manifestVersion: 1,
    manifestActorPeerId: identity.peerId,
    manifestOperationId: "operation_12345678",
    administratorEpoch: 1,
    administratorPeerIds: [],
    administratorGrants: [],
    removedPeerIds: [],
    removedMembers: [],
    revocations: [],
    rendezvousVersion: 1,
    rendezvousSecret: "secret_12345678",
    members: [identity],
    joinedAt: 1,
  };
}

describe("group sync budget", () => {
  it("allows a normal group snapshot", () => {
    expect(() => assertLocalGroupSyncBudget(group())).not.toThrow();
  });

  it("rejects a state that cannot fit in one safe control envelope", () => {
    expect(() => assertLocalGroupSyncBudget(group(`data:image/png;base64,${"A".repeat(70 * 1024)}`))).toThrow(/orçamento seguro/);
  });
});
