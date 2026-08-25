import type { PublicPeerIdentity } from "./social-storage";

export function dedupeMembersForDisplay(members: PublicPeerIdentity[], preferred?: PublicPeerIdentity): PublicPeerIdentity[] {
  const unique = new Map<string, PublicPeerIdentity>();
  const preferredName = preferred ? normalizedDisplayName(preferred.displayName) : "";
  for (const member of members) {
    const resolved = preferred && sameIdentity(member, preferred) ? preferred : member;
    const key = normalizedDisplayName(resolved.displayName);
    if (!key) continue;
    if (!unique.has(key) || (preferred && key === preferredName)) {
      unique.set(key, preferred && key === preferredName ? preferred : resolved);
    }
  }
  return [...unique.values()];
}

function sameIdentity(left: PublicPeerIdentity, right: PublicPeerIdentity): boolean {
  return left.peerId === right.peerId || (
    left.publicKey.x === right.publicKey.x
    && left.publicKey.y === right.publicKey.y
    && left.publicKey.crv === right.publicKey.crv
  );
}

function normalizedDisplayName(displayName: string): string {
  return displayName.trim().normalize("NFKC").toLocaleLowerCase();
}
