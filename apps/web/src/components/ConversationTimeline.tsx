import type { ChatMessage } from "../api";
import type { ChatAttachmentProgress, ChatAttachmentRecord } from "../chat";
import { AttachmentCard } from "./AttachmentCard";

export function ConversationTimeline({
  messages,
  attachments,
  progress,
  connected,
  loadBlob,
  onDownload,
  onRequest,
  onPause,
  onResume,
  onCancel,
}: {
  messages: ChatMessage[];
  attachments: ChatAttachmentRecord[];
  progress: Record<string, ChatAttachmentProgress | undefined>;
  connected: boolean;
  loadBlob(record: ChatAttachmentRecord): Promise<Blob>;
  onDownload(record: ChatAttachmentRecord): Promise<void>;
  onRequest(record: ChatAttachmentRecord): Promise<void>;
  onPause(record: ChatAttachmentRecord): Promise<void>;
  onResume(record: ChatAttachmentRecord): Promise<void>;
  onCancel(record: ChatAttachmentRecord): Promise<void>;
}) {
  const items = [
    ...messages.map((message) => ({ type: "message" as const, createdAt: message.createdAt, message })),
    ...attachments.map((record) => ({ type: "attachment" as const, createdAt: record.createdAt, record })),
  ].sort((left, right) => left.createdAt.localeCompare(right.createdAt));

  return <>
    {items.map((item) => item.type === "message"
      ? <article key={`message:${item.message.id}`}>
          <div className="avatar">{item.message.author[0]}</div>
          <div><strong>{item.message.author}</strong><time>{new Date(item.message.createdAt).toLocaleString()}</time><p>{item.message.content}</p></div>
        </article>
      : <div className="attachment-timeline-item" key={`attachment:${item.record.attachmentId}`}>
          <AttachmentCard
            record={item.record}
            progress={progress[item.record.attachmentId]}
            connected={connected}
            loadBlob={loadBlob}
            onDownload={onDownload}
            onRequest={onRequest}
            onPause={onPause}
            onResume={onResume}
            onCancel={onCancel}
          />
        </div>)}
  </>;
}
