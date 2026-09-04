import {
  parseChatWireEnvelope,
  type MessageAckWireMessage,
  type SignedChatEventWireMessage,
  type SignedChatWireMessage,
} from "./MessageProtocol";
import {
  enqueueOutbox,
  loadOutbox,
  markOutboxAttempt,
  removeOutbox,
} from "../services/offline/outbox-storage";

export class OutboxService {
  enqueue(message: SignedChatWireMessage | SignedChatEventWireMessage): Promise<void> {
    return enqueueOutbox(message.channelId, message.id, JSON.stringify(message));
  }

  acknowledge(channelId: string, messageId: string): Promise<void> {
    return removeOutbox(channelId, messageId);
  }

  createAck(channelId: string, messageId: string): MessageAckWireMessage {
    return { version: 2, type: "chat.message.ack", channelId, messageId };
  }

  async flush(
    channelId: string,
    remotePeerId: string,
    send: (wire: string, peerId: string) => number,
    isActive: () => boolean,
    canSend: (envelope: SignedChatWireMessage | SignedChatEventWireMessage) => boolean = () => true,
  ): Promise<void> {
    const records = await loadOutbox(channelId);
    if (!isActive()) return;
    for (const record of records) {
      if (!isActive()) return;
      const envelope = parseChatWireEnvelope(record.wire, channelId);
      if (!envelope || !(
        (envelope.type === "chat.message" && envelope.version === 2)
        || envelope.type === "chat.event"
      )) {
        await removeOutbox(channelId, record.messageId);
        continue;
      }
      if (canSend(envelope) && send(record.wire, remotePeerId) > 0) await markOutboxAttempt(record);
    }
  }
}
