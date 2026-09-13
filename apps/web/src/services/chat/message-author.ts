import type { ChatMessage } from "../../application/contracts";

export type ChatAuthorProfile = { peerId: string; displayName: string; avatar?: string };

export function resolveMessageAuthor(message: Pick<ChatMessage, "author" | "authorPeerId">, profiles: readonly ChatAuthorProfile[]): ChatAuthorProfile {
  const identified = message.authorPeerId ? profiles.find((profile) => profile.peerId === message.authorPeerId) : undefined;
  if (identified) return identified;
  // Mensagens legadas sem identidade só usam o nome quando não há ambiguidade.
  const matches = !message.authorPeerId
    ? profiles.filter((profile) => profile.displayName.trim().toLocaleLowerCase() === message.author.trim().toLocaleLowerCase())
    : [];
  return matches.length === 1 ? matches[0]! : { peerId: message.authorPeerId ?? "", displayName: message.author };
}
