export const RISK_ATTACHMENT_PROTOCOL_VERSION = 1 as const;

export const DEFAULT_ATTACHMENT_CHUNK_SIZE = 64 * 1024;
export const MAX_ATTACHMENT_FILENAME_LENGTH = 255;
export const MAX_ATTACHMENT_MIME_LENGTH = 127;
export const MAX_ATTACHMENT_CHUNKS = 1_000_000;

export type RiskCapability =
  | "file-transfer-v1"
  | "attachment-sync-v1"
  | "transfer-resume-v1"
  | "multi-source-v1";

export type PeerCapabilitiesMessage = {
  type: "peer.capabilities";
  protocolVersion: number;
  capabilities: RiskCapability[];
};

export type AttachmentKind = "image" | "video" | "audio" | "document" | "archive" | "executable" | "other";

export type AttachmentMetadata = {
  width?: number;
  height?: number;
  durationMs?: number;
  thumbnailHash?: string;
  voiceMessage?: boolean;
};

export type AttachmentManifest = {
  protocolVersion: typeof RISK_ATTACHMENT_PROTOCOL_VERSION;
  id: string;
  messageId?: string;
  channelId?: string;
  senderPeerId: string;
  filename: string;
  mimeType: string;
  extension?: string;
  kind: AttachmentKind;
  size: number;
  contentHash: string;
  chunkSize: number;
  chunkCount: number;
  chunkHashes?: string[];
  createdAt: string;
  metadata?: AttachmentMetadata;
};

export type AttachmentTransferState =
  | "offered"
  | "waiting"
  | "accepted"
  | "queued"
  | "transferring"
  | "paused"
  | "verifying"
  | "completed"
  | "failed"
  | "cancelled";

export type AttachmentTransferProgress = {
  transferId: string;
  attachmentId: string;
  peerId: string;
  state: AttachmentTransferState;
  bytesTransferred: number;
  totalBytes: number;
  retryCount: number;
  startedAt?: string;
  updatedAt: string;
  lastError?: string;
};

export type FileOfferMessage = { type: "file.offer"; transferId: string; manifest: AttachmentManifest };
export type FileRequestMessage = { type: "file.request"; attachmentId: string };
export type FileAcceptMessage = { type: "file.accept"; transferId: string };
export type FileRejectMessage = { type: "file.reject"; transferId: string; reason?: string };
export type FileManifestMessage = { type: "file.manifest"; transferId: string; manifest: AttachmentManifest };
export type FileNeedMessage = { type: "file.need"; transferId: string; missingChunks: number[] };
export type FilePauseMessage = { type: "file.pause"; transferId: string };
export type FileResumeMessage = { type: "file.resume"; transferId: string; missingChunks?: number[] };
export type FileCancelMessage = { type: "file.cancel"; transferId: string; reason?: string };
export type FileCompleteMessage = { type: "file.complete"; transferId: string; contentHash: string };
export type FileErrorMessage = { type: "file.error"; transferId: string; code: string; message: string; retryable: boolean };
export type FileAvailabilityMessage = {
  type: "file.availability";
  attachmentId: string;
  chunkCount: number;
  availableChunks: number[];
  expiresAt: string;
};

export type FileControlMessage =
  | PeerCapabilitiesMessage
  | FileOfferMessage
  | FileRequestMessage
  | FileAcceptMessage
  | FileRejectMessage
  | FileManifestMessage
  | FileNeedMessage
  | FilePauseMessage
  | FileResumeMessage
  | FileCancelMessage
  | FileCompleteMessage
  | FileErrorMessage
  | FileAvailabilityMessage;

export type AttachmentChunkFrame = {
  transferId: string;
  attachmentId: string;
  index: number;
  offset: number;
  size: number;
  hash: string;
  payload: ArrayBuffer;
};

export function classifyAttachment(mimeType: string, filename = ""): AttachmentKind {
  const mime = mimeType.toLowerCase();
  const extension = filename.toLowerCase().split(".").pop() ?? "";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (["zip", "rar", "7z", "tar", "gz", "bz2", "xz"].includes(extension)) return "archive";
  if (["exe", "msi", "bat", "cmd", "com", "ps1", "scr", "jar", "appimage", "deb", "rpm"].includes(extension)) return "executable";
  if (mime.startsWith("text/") || mime === "application/pdf" || mime.includes("document") || mime.includes("spreadsheet") || mime.includes("presentation")) return "document";
  return "other";
}

export function validateAttachmentManifest(manifest: AttachmentManifest): string[] {
  const errors: string[] = [];
  if (manifest.protocolVersion !== RISK_ATTACHMENT_PROTOCOL_VERSION) errors.push("unsupported_protocol_version");
  if (!manifest.id) errors.push("missing_attachment_id");
  if (!manifest.senderPeerId) errors.push("missing_sender_peer_id");
  if (!manifest.filename || manifest.filename.length > MAX_ATTACHMENT_FILENAME_LENGTH) errors.push("invalid_filename");
  if (manifest.mimeType.length > MAX_ATTACHMENT_MIME_LENGTH) errors.push("invalid_mime_type");
  if (!Number.isSafeInteger(manifest.size) || manifest.size < 0) errors.push("invalid_size");
  if (!Number.isSafeInteger(manifest.chunkSize) || manifest.chunkSize <= 0) errors.push("invalid_chunk_size");
  if (!Number.isSafeInteger(manifest.chunkCount) || manifest.chunkCount < 0 || manifest.chunkCount > MAX_ATTACHMENT_CHUNKS) errors.push("invalid_chunk_count");
  if (!/^[a-f0-9]{64}$/i.test(manifest.contentHash)) errors.push("invalid_content_hash");
  if (manifest.chunkHashes && manifest.chunkHashes.length !== manifest.chunkCount) errors.push("invalid_chunk_hash_count");
  return errors;
}

export function isFileControlMessage(value: unknown): value is FileControlMessage {
  if (!value || typeof value !== "object") return false;
  const type = (value as { type?: unknown }).type;
  return type === "peer.capabilities"
    || type === "file.offer"
    || type === "file.request"
    || type === "file.accept"
    || type === "file.reject"
    || type === "file.manifest"
    || type === "file.need"
    || type === "file.pause"
    || type === "file.resume"
    || type === "file.cancel"
    || type === "file.complete"
    || type === "file.error"
    || type === "file.availability";
}

export function sanitizeAttachmentFilename(filename: string): string {
  const base = filename.replace(/\\/g, "/").split("/").pop() ?? "attachment";
  const cleaned = base.replace(/[\u0000-\u001f<>:"|?*]/g, "_").replace(/^\.+$/, "attachment").trim();
  return (cleaned || "attachment").slice(0, MAX_ATTACHMENT_FILENAME_LENGTH);
}
