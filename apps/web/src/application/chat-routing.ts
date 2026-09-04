export type CallChatOwnershipInput = {
  roomId?: string | null;
  conversationId?: string | null;
  callTextChannelId?: string | null;
  privateConversation: boolean;
};

/**
 * A chamada mantém uma única sessão RTC para o canal de texto do grupo.
 * As duas interfaces devem observar essa sessão enquanto ela for a dona do canal.
 */
export function callOwnsTextConversation(input: CallChatOwnershipInput): boolean {
  return !input.privateConversation
    && Boolean(input.roomId)
    && Boolean(input.conversationId)
    && input.conversationId === input.callTextChannelId;
}
