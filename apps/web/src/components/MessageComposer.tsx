import { useRef, useState } from "react";
import { Paperclip, Send } from "lucide-react";

export function MessageComposer({
  placeholder,
  canAttach,
  onSubmit,
  onFiles,
}: {
  placeholder: string;
  canAttach: boolean;
  onSubmit(event: React.FormEvent<HTMLFormElement>): void | Promise<void>;
  onFiles(files: File[]): Promise<void>;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [preparing, setPreparing] = useState(false);

  async function selectFiles(event: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (!files.length) return;
    setPreparing(true);
    try { await onFiles(files); }
    finally { setPreparing(false); }
  }

  return <form className="message-box" onSubmit={(event) => void onSubmit(event)}>
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
    <input name="message" maxLength={4000} placeholder={preparing ? "Preparando e verificando arquivo…" : placeholder} autoComplete="off" disabled={preparing}/>
    <button type="submit" disabled={preparing}><Send/></button>
  </form>;
}
