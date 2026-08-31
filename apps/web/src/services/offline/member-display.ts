import type { PublicPeerIdentity } from "./social-storage";

export function dedupeMembersForDisplay(members: PublicPeerIdentity[], preferred?: PublicPeerIdentity): PublicPeerIdentity[] {
  const unique: PublicPeerIdentity[] = [];
  for (const member of members) {
    const resolved = preferred && sameIdentity(member, preferred) ? preferred : member;
    const existing = unique.findIndex((candidate) => sameIdentity(candidate, resolved));
    if (existing < 0) unique.push(resolved);
    else if (preferred && sameIdentity(resolved, preferred)) unique[existing] = preferred;
  }
  return unique;
}

function sameIdentity(left: PublicPeerIdentity, right: PublicPeerIdentity): boolean {
  return left.peerId === right.peerId || (
    left.publicKey.x === right.publicKey.x
    && left.publicKey.y === right.publicKey.y
    && left.publicKey.crv === right.publicKey.crv
  );
}
