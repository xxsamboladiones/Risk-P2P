import { useEffect, useState } from "react";
import {
  Archive,
  Download,
  File,
  FileWarning,
  Image as ImageIcon,
  Music,
  Pause,
  Play,
  RotateCcw,
  Video,
  X,
} from "lucide-react";
import type { ChatAttachmentProgress, ChatAttachmentRecord } from "../chat";
import "./attachments.css";

export type AttachmentCardProps = {
  record: ChatAttachmentRecord;
  progress?: ChatAttachmentProgress;
  connected: boolean;
  loadBlob(record: ChatAttachmentRecord): Promise<Blob>;
  onDownload(record: ChatAttachmentRecord): Promise<void>;
  onRequest(record: ChatAttachmentRecord): Promise<void>;
  onPause(record: ChatAttachmentRecord): Promise<void>;
  onResume(record: ChatAttachmentRecord): Promise<void>;
  onCancel(record: ChatAttachmentRecord): Promise<void>;
};

export function AttachmentCard(props: AttachmentCardProps) {
  const { record, progress, connected } = props;
  const { manifest } = record;
  const canPreview = record.state === "completed" || record.direction === "outgoing";
  const [previewUrl, setPreviewUrl] = useState<string>();
  const [previewError, setPreviewError] = useState("");

  useEffect(() => {
    let active = true;
    let objectUrl: string | undefined;
    if (!canPreview || !["image", "video", "audio"].includes(manifest.kind)) {
      setPreviewUrl(undefined);
      return () => undefined;
    }
    void props.loadBlob(record)
      .then((blob) => {
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setPreviewUrl(objectUrl);
        setPreviewError("");
      })
      .catch((error) => { if (active) setPreviewError(error instanceof Error ? error.message : "Preview indisponível"); });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [record.attachmentId, record.state, record.direction, canPreview]);

  const percent = progress?.progressPercent ?? (record.totalBytes > 0 ? (record.bytesTransferred / record.totalBytes) * 100 : 0);
  const speed = progress?.speedBytesPerSecond ?? 0;
  const eta = progress?.etaSeconds;
  const activeTransfer = ["accepted", "queued", "transferring", "verifying"].includes(record.state);
  const downloadable = record.state === "completed" || record.direction === "outgoing";

  return <article className={`attachment-card kind-${manifest.kind} state-${record.state}`}>
    {manifest.kind === "image" && previewUrl && <img className="attachment-image" src={previewUrl} alt={manifest.filename}/>} 
    {manifest.kind === "video" && previewUrl && <video className="attachment-media" src={previewUrl} controls preload="metadata"/>}
    {manifest.kind === "audio" && previewUrl && <audio className="attachment-audio" src={previewUrl} controls preload="metadata"/>}
    {previewError && <small className="attachment-preview-error">{previewError}</small>}

    <div className="attachment-info">
      <div className="attachment-kind">{kindIcon(manifest.kind)}</div>
      <div className="attachment-copy">
        <strong title={manifest.filename}>{manifest.filename}</strong>
        <span>{formatBytes(manifest.size)} · {kindLabel(manifest.kind)}</span>
        {manifest.kind === "executable" && <em className="attachment-warning"><FileWarning size={14}/> Executável recebido. O Risk nunca abre este arquivo automaticamente.</em>}
      </div>
    </div>

    {(activeTransfer || record.state === "paused") && <div className="attachment-progress">
      <div><i style={{ width: `${Math.max(0, Math.min(100, percent))}%` }}/></div>
      <span>{formatBytes(record.bytesTransferred)} / {formatBytes(record.totalBytes)}</span>
      <span>{speed > 0 ? `${formatBytes(speed)}/s` : "Aguardando dados"}{eta && Number.isFinite(eta) ? ` · ${formatEta(eta)}` : ""}</span>
    </div>}

    {record.lastError && <div className="attachment-error">{record.lastError}</div>}
    <div className="attachment-actions">
      {record.state === "waiting" && <button disabled={!connected} onClick={() => void props.onRequest(record)}><Download size={15}/> Baixar</button>}
      {record.state === "paused" && <button disabled={!connected} onClick={() => void props.onResume(record)}><Play size={15}/> Retomar</button>}
      {activeTransfer && record.state !== "verifying" && <button onClick={() => void props.onPause(record)}><Pause size={15}/> Pausar</button>}
      {record.state === "failed" && <button disabled={!connected} onClick={() => void props.onResume(record)}><RotateCcw size={15}/> Tentar novamente</button>}
      {activeTransfer && <button className="danger" onClick={() => void props.onCancel(record)}><X size={15}/> Cancelar</button>}
      {downloadable && <button onClick={() => void props.onDownload(record)}><Download size={15}/> Salvar arquivo</button>}
    </div>
  </article>;
}

function kindIcon(kind: ChatAttachmentRecord["manifest"]["kind"]) {
  if (kind === "image") return <ImageIcon size={20}/>;
  if (kind === "video") return <Video size={20}/>;
  if (kind === "audio") return <Music size={20}/>;
  if (kind === "archive") return <Archive size={20}/>;
  if (kind === "executable") return <FileWarning size={20}/>;
  return <File size={20}/>;
}

function kindLabel(kind: ChatAttachmentRecord["manifest"]["kind"]): string {
  return ({ image: "Imagem", video: "Vídeo", audio: "Áudio", document: "Documento", archive: "Arquivo compactado", executable: "Executável", other: "Arquivo" })[kind];
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / (1024 ** index);
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function formatEta(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.ceil(seconds))}s restantes`;
  if (seconds < 3600) return `${Math.ceil(seconds / 60)}min restantes`;
  return `${(seconds / 3600).toFixed(1)}h restantes`;
}
