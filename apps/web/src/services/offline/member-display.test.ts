import { describe, expect, it } from "vitest";
import type { PublicPeerIdentity } from "./social-storage";
import { dedupeMembersForDisplay } from "./member-display";

function identity(peerId: string, displayName: string, key: string, avatar?: string): PublicPeerIdentity {
  return { peerId, displayName, avatar, publicKey: { kty: "EC", crv: "P-256", x: key, y: `${key}-y` } };
}

describe("dedupeMembersForDisplay", () => {
  it("mantém somente a identidade local atual quando existem cópias antigas com o mesmo nome", () => {
    const oldA = identity("old-peer-a", "xxsam", "old-a");
    const oldB = identity("old-peer-b", " XXSAM ", "old-b");
    const current = identity("current-peer", "xxsam", "current", "data:image/webp;base64,YQ==");
    const other = identity("other-peer", "DennisGames", "other");

    expect(dedupeMembersForDisplay([oldA, other, oldB, current], current)).toEqual([current, other]);
  });
});
