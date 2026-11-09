import { useEffect, useRef, useState, type ChangeEvent, type ClipboardEvent, type DragEvent, type FormEvent } from "react";
import { File as FileIcon, Paperclip, Reply, Send, X } from "lucide-react";
import type { ChatMessage } from "../application/contracts";
import {
  clipboardImageFiles,
  confirmPendingAttachments,
  removePendingAttachment,
  revokePendingAttachments,
  stageAttachmentFiles,
  type PendingComposerAttachment,
} from "./message-composer-attachments";

export function MessageComposer({
  placeholder,
  canAttach,
  onSubmit,
  onFiles,
  replyingTo,
  onCancelReply,
  onTyping,
  mentionCandidates = [],
}: {
  placeholder: string;
  canAttach: boolean;
  onSubmit(event: FormEvent<HTMLFormElement>): void | Promise<void>;
  onFiles(files: File[]): Promise<void>;
  replyingTo?: ChatMessage | null;
  onCancelReply?(): void;
  onTyping?(active: boolean): void;
  mentionCandidates?: string[];
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const messageInput = useRef<HTMLInputElement>(null);
  const [preparing, setPreparing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<PendingComposerAttachment[]>([]);
  const pendingRef = useRef<PendingComposerAttachment[]>([]);
  pendingRef.current = pending;

  useEffect(() => () => revokePendingAttachments(pendingRef.current), []);

  function queueFiles(files: readonly File[]) {
    if (!files.length) return;
    setPending((current) => [...current, ...stageAttachmentFiles(files)]);
  }

  function selectFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    queueFiles(files);
  }

  function dropped(event: DragEvent<HTMLFormElement>) {
    event.preventDefault();
    setDragging(false);
    if (!canAttach || preparing) return;
    const files = Array.from(event.dataTransfer.files ?? []);
    queueFiles(files);
  }

  function pasted(event: ClipboardEvent<HTMLInputElement>) {
    if (!canAttach || preparing) return;
    const images = clipboardImageFiles(event.clipboardData.items);
    if (!images.length) return;
    event.preventDefault();
    queueFiles(images);
  }

  function removeFile(id: string) {
    const next = removePendingAttachment(pending, id);
    setPending(next);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (preparing) return;
    const snapshot = pending;
    if (!snapshot.length) {
      try { await onSubmit(event); }
      finally { setDraft(messageInput.current?.value ?? ""); }
      return;
    }

    setPreparing(true);
    try {
      await onSubmit(event);
      await confirmPendingAttachments(snapshot, onFiles, (url) => URL.revokeObjectURL(url), (id) => {
        setPending((current) => current.filter((item) => item.id !== id));
      });
    } catch {
      // O callback da conversa já apresenta o erro e o item que falhou permanece
      // na prévia para uma nova tentativa.
    } finally {
      setPreparing(false);
      setDraft(messageInput.current?.value ?? "");
    }
  }

  const mentionMatch = /(?:^|\s)@([\p{L}\p{N}_-]*)$/u.exec(draft);
  const suggestions = mentionMatch
    ? [...new Set(mentionCandidates)].filter((name) => name.toLocaleLowerCase().startsWith(mentionMatch[1]!.toLocaleLowerCase())).slice(0, 6)
    : [];

  function chooseMention(name: string) {
    const next = draft.replace(/(?:^|\s)@[\p{L}\p{N}_-]*$/u, (token) => `${token.startsWith(" ") ? " " : ""}@[${name}] `);
    if (messageInput.current) messageInput.current.value = next;
    setDraft(next);
    onTyping?.(true);
    messageInput.current?.focus();
  }

  return <form
    className={`message-box ${dragging ? "is-dragging" : ""} ${replyingTo ? "has-reply" : ""} ${pending.length ? "has-attachments" : ""}`}
    onSubmit={(event) => void submit(event)}
    onDragEnter={(event) => { event.preventDefault(); if (canAttach) setDragging(true); }}
    onDragOver={(event) => event.preventDefault()}
    onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
    onDrop={dropped}
  >
    {replyingTo && <div className="composer-reply"><Reply size={15}/><span>Respondendo a <strong>{replyingTo.author}</strong></span><button type="button" onClick={onCancelReply} aria-label="Cancelar resposta"><X size={15}/></button></div>}
    {suggestions.length > 0 && <div className="mention-suggestions" role="listbox">
      {suggestions.map((name) => <button type="button" key={name} onClick={() => chooseMention(name)}>@{name}</button>)}
    </div>}
    {dragging && <div className="attachment-drop-hint">Solte para adicionar à prévia</div>}
    {pending.length > 0 && <div className="composer-attachments" aria-live="polite">
      {pending.map((item) => <article className="composer-attachment" key={item.id}>
        {item.previewUrl
          ? <img src={item.previewUrl} alt={`Prévia de ${item.file.name}`}/>
          : <div className="composer-file-icon"><FileIcon size={25}/></div>}
        <span title={item.file.name}>{item.file.name}</span>
        <small>{formatFileSize(item.file.size)}</small>
        <button type="button" disabled={preparing} onClick={() => removeFile(item.id)} aria-label={`Remover ${item.file.name}`} title="Remover anexo"><X size={15}/></button>
      </article>)}
    </div>}
    <input ref={fileInput} className="attachment-file-input" type="file" multiple onChange={selectFiles}/>
    <button
      type="button"
      className="attachment-trigger"
      disabled={!canAttach || preparing}
      title={canAttach ? "Enviar arquivo P2P" : "Conecte o chat P2P para enviar arquivos"}
      onClick={() => fileInput.current?.click()}
    >
      <Paperclip size={19}/><span className="sr-only">Anexar arquivo</span>
    </button>
    <input
      ref={messageInput}
      name="message"
      maxLength={4000}
      placeholder={preparing ? "Preparando e verificando arquivo…" : placeholder}
      autoComplete="off"
      disabled={preparing}
      onChange={(event) => { setDraft(event.target.value); onTyping?.(Boolean(event.target.value.trim())); }}
      onBlur={() => onTyping?.(false)}
      onPaste={pasted}
    />
    <button type="submit" disabled={preparing}><Send/></button>
  </form>;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
