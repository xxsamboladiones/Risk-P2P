import type { ChatMessage } from "../../application/contracts";

/** Mensagens recebidas ao carregar o histórico têm precedência sobre o snapshot. */
export function mergeMessageHistory(history: ChatMessage[], received: ChatMessage[]): ChatMessage[] {
  return [...new Map([...history, ...received].map((message) => [message.id, message])).values()]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
}
