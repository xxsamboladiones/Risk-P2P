import { useRef, useState, type ChangeEvent, type DragEvent, type FormEvent } from "react";
import { Paperclip, Reply, Send, X } from "lucide-react";
import type { ChatMessage } from "../application/contracts";

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

  async function selectFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (!files.length) return;
    setPreparing(true);
    try { await onFiles(files); }
    finally { setPreparing(false); }
  }

  async function dropped(event: DragEvent<HTMLFormElement>) {
    event.preventDefault();
    setDragging(false);
    if (!canAttach || preparing) return;
    const files = Array.from(event.dataTransfer.files ?? []);
    if (!files.length) return;
    setPreparing(true);
    try { await onFiles(files); }
    finally { setPreparing(false); }
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
    className={`message-box ${dragging ? "is-dragging" : ""} ${replyingTo ? "has-reply" : ""}`}
    onSubmit={(event) => { void Promise.resolve(onSubmit(event)).finally(() => setDraft(messageInput.current?.value ?? "")); }}
    onDragEnter={(event) => { event.preventDefault(); if (canAttach) setDragging(true); }}
    onDragOver={(event) => event.preventDefault()}
    onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
    onDrop={(event) => void dropped(event)}
  >
    {replyingTo && <div className="composer-reply"><Reply size={15}/><span>Respondendo a <strong>{replyingTo.author}</strong></span><button type="button" onClick={onCancelReply} aria-label="Cancelar resposta"><X size={15}/></button></div>}
    {suggestions.length > 0 && <div className="mention-suggestions" role="listbox">
      {suggestions.map((name) => <button type="button" key={name} onClick={() => chooseMention(name)}>@{name}</button>)}
    </div>}
    {dragging && <div className="attachment-drop-hint">Solte para enviar pelo P2P</div>}
    <input ref={fileInput} className="attachment-file-input" type="file" multiple onChange={(event) => void selectFiles(event)}/>
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
    />
    <button type="submit" disabled={preparing}><Send/></button>
  </form>;
}
