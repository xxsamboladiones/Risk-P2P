import {
  DEFAULT_ATTACHMENT_CHUNK_SIZE,
  RISK_ATTACHMENT_PROTOCOL_VERSION,
  classifyAttachment,
  isFileControlMessage,
  sanitizeAttachmentFilename,
  validateAttachmentManifest,
  type AttachmentManifest,
  type AttachmentTransferProgress,
  type FileControlMessage,
  type RiskCapability,
} from "@risk/protocol/attachments";
import {
  MAX_SYNC_DESCRIPTORS_PER_PAGE,
  MAX_SYNC_ITEMS_PER_MESSAGE,
  MAX_SYNC_NEED_IDS,
  RISK_SYNC_PROTOCOL_VERSION,
  isSyncWireMessage,
  syncCheckpointId,
  type SyncCheckpoint,
  type SyncDescriptor,
  type SyncWireMessage,
} from "@risk/protocol/sync";
import { MeshWebRTCTransport } from "@risk/rtc";
import { decodeAttachmentChunkFrame, encodeAttachmentChunkFrame } from "@risk/rtc/file-chunk-codec";
import { AttachmentTransferReceiver, type AttachmentChunkSink } from "@risk/rtc/file-receiver";
import { AttachmentTransferSender, sha256Hex, type TransferSource } from "@risk/rtc/file-transfer";
import { IncrementalSha256 } from "@risk/rtc/streaming-sha256";
import { OFFLINE_STORES, getFromStore, putInStore } from "../offline/database";
import { IndexedDbAttachmentStorage, type StoredAttachmentRecord } from "./indexeddb-storage";

const LOCAL_CAPABILITIES: RiskCapability[] = ["file-transfer-v1", "attachment-sync-v1", "transfer-resume-v1"];
const MAX_MANIFEST_CHUNK_HASHES = 512;
const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024 * 1024;

export type AttachmentRuntimeState = {
  record: StoredAttachmentRecord;
  progressPercent: number;
  speedBytesPerSecond: number;
  etaSeconds?: number;
};

type ProgressSample = { bytes: number; timestamp: number; speed: number };
type SyncRequestState = { peerId: string; stateHash: string };

export interface AttachmentStorage extends AttachmentChunkSink {
  persistOutgoingSource(transferId: string, channelId: string, peerId: string, source: Blob, manifest: AttachmentManifest): Promise<StoredAttachmentRecord>;
  registerOutgoing(transferId: string, channelId: string, peerId: string, manifest: AttachmentManifest): Promise<StoredAttachmentRecord>;
  registerSyncedMetadata(peerId: string, manifest: AttachmentManifest): Promise<StoredAttachmentRecord>;
  updateProgress(progress: AttachmentTransferProgress): Promise<StoredAttachmentRecord | undefined>;
  listChannel(channelId: string): Promise<StoredAttachmentRecord[]>;
  findByTransferId(transferId: string): Promise<StoredAttachmentRecord | undefined>;
  findAnyByAttachmentId(attachmentId: string): Promise<StoredAttachmentRecord | undefined>;
  findCompletedByAttachmentId(attachmentId: string): Promise<StoredAttachmentRecord | undefined>;
  getBlob(attachmentId: string, manifest?: AttachmentManifest): Promise<Blob>;
  saveRecord(record: StoredAttachmentRecord): Promise<void>;
}

export class AttachmentService extends EventTarget {
  private readonly sender: AttachmentTransferSender;
  private readonly receiver: AttachmentTransferReceiver;
  private readonly outgoing = new Map<string, { peerId: string; attachmentId: string }>();
  private readonly sourceByAttachment = new Map<string, TransferSource>();
  private readonly peerCapabilities = new Map<string, ReadonlySet<RiskCapability>>();
  private readonly progressSamples = new Map<string, ProgressSample>();
  private readonly syncRequests = new Map<string, SyncRequestState>();

  constructor(
    private readonly transport: MeshWebRTCTransport,
    private readonly channelId: string,
    private readonly localPeerId: string,
    private readonly authenticatedPeers: () => readonly string[],
    private readonly storage: AttachmentStorage = new IndexedDbAttachmentStorage(),
  ) {
    super();
    this.sender = new AttachmentTransferSender(
      (peerId, message) => this.sendControl(peerId, message),
      async (peerId, frame) => {
        const encoded = encodeAttachmentChunkFrame(frame);
        if (this.transport.sendTransferData(encoded, peerId) > 0) return;
        await this.transport.waitForTransferBufferedAmountLow(peerId);
        if (this.transport.sendTransferData(encoded, peerId) === 0) throw new Error("Canal risk.transfer congestionado ou indisponível.");
      },
      {
        getBufferedAmount: (peerId) => this.transport.getTransferBufferedAmount(peerId),
        waitForBufferedAmountLow: (peerId) => this.transport.waitForTransferBufferedAmountLow(peerId),
      },
    );
    this.receiver = new AttachmentTransferReceiver(
      storage,
      (peerId, message) => this.sendControl(peerId, message),
      {
        maxFileSizeBytes: MAX_FILE_SIZE_BYTES,
        autoAccept: (peerId, manifest) => this.isAuthenticated(peerId)
          && manifest.senderPeerId === peerId
          && manifest.channelId === this.channelId,
      },
    );
    this.sender.addEventListener("progress", (event) => { void this.onProgress((event as CustomEvent<AttachmentTransferProgress>).detail); });
    this.receiver.addEventListener("progress", (event) => { void this.onProgress((event as CustomEvent<AttachmentTransferProgress>).detail); });
    this.receiver.addEventListener("offer", (event) => {
      const detail = (event as CustomEvent<{ transferId: string; peerId: string; manifest: AttachmentManifest }>).detail;
      this.dispatchEvent(new CustomEvent("offer", { detail }));
    });
  }

  history(): Promise<StoredAttachmentRecord[]> { return this.storage.listChannel(this.channelId); }

  async peerReady(peerId: string): Promise<void> {
    if (!this.isAuthenticated(peerId)) return;
    await this.sendControl(peerId, {
      type: "peer.capabilities",
      protocolVersion: RISK_ATTACHMENT_PROTOCOL_VERSION,
      capabilities: LOCAL_CAPABILITIES,
    });
    await this.sendSyncHello(peerId);
  }

  forgetPeer(peerId: string): void {
    this.peerCapabilities.delete(peerId);
  }

  async sendFile(file: File): Promise<AttachmentManifest> {
    const peers = this.authenticatedPeers().filter((peerId) => {
      const capabilities = this.peerCapabilities.get(peerId);
      return capabilities?.has("file-transfer-v1") && this.transport.isTransferChannelOpen(peerId);
    });
    if (peers.length === 0) throw new Error("Nenhum peer autenticado com suporte a arquivos possui o canal risk.transfer aberto.");
    if (file.size > MAX_FILE_SIZE_BYTES) throw new Error("O arquivo excede o limite de 20 GiB desta versão do Risk.");

    const manifest = await buildManifest(file, this.channelId, this.localPeerId);
    this.sourceByAttachment.set(manifest.id, file);
    let persistedSource = false;
    for (const peerId of peers) {
      const transferId = await this.sender.offer(peerId, file, manifest);
      this.outgoing.set(transferId, { peerId, attachmentId: manifest.id });
      if (!persistedSource) {
        try {
          await this.storage.persistOutgoingSource(transferId, this.channelId, peerId, file, manifest);
          persistedSource = true;
        } catch (error) {
          await this.storage.registerOutgoing(transferId, this.channelId, peerId, manifest);
          console.warn("Não foi possível manter uma cópia offline completa do anexo enviado.", error);
        }
      } else {
        await this.storage.registerOutgoing(transferId, this.channelId, peerId, manifest);
      }
      const record = await this.storage.findByTransferId(transferId);
      if (record) this.emitRecord(record);
    }
    return manifest;
  }

  async requestDownload(record: StoredAttachmentRecord): Promise<void> {
    if (record.channelId !== this.channelId) throw new Error("Anexo pertence a outro canal.");
    if (record.state === "completed") return;
    if (!this.isAuthenticated(record.peerId)) throw new Error("O peer que possui este arquivo não está conectado.");
    const capabilities = this.peerCapabilities.get(record.peerId);
    if (!capabilities?.has("file-transfer-v1")) throw new Error("O peer conectado não oferece transferência de arquivos nesta versão.");
    await this.sendControl(record.peerId, { type: "file.request", attachmentId: record.attachmentId });
    const updated = { ...record, state: "waiting" as const, updatedAt: new Date().toISOString() };
    await this.storage.saveRecord(updated);
    this.emitRecord(updated);
  }

  async pause(record: StoredAttachmentRecord): Promise<void> {
    if (record.transferId.startsWith("sync:")) return;
    if (record.direction === "outgoing") {
      this.sender.pause(record.transferId);
    } else {
      await this.receiver.handleControl(record.peerId, { type: "file.pause", transferId: record.transferId });
    }
    await this.sendControl(record.peerId, { type: "file.pause", transferId: record.transferId });
  }

  async resume(record: StoredAttachmentRecord): Promise<void> {
    if (record.transferId.startsWith("sync:")) { await this.requestDownload(record); return; }
    if (record.direction === "outgoing") {
      this.sender.resume(record.transferId);
    } else {
      await this.receiver.handleControl(record.peerId, { type: "file.resume", transferId: record.transferId });
    }
    await this.sendControl(record.peerId, { type: "file.resume", transferId: record.transferId });
  }

  async cancel(record: StoredAttachmentRecord): Promise<void> {
    if (record.transferId.startsWith("sync:")) {
      const updated = { ...record, state: "cancelled" as const, updatedAt: new Date().toISOString() };
      await this.storage.saveRecord(updated);
      this.emitRecord(updated);
      return;
    }
    if (record.direction === "outgoing") this.sender.cancel(record.transferId);
    else await this.receiver.cancel(record.transferId);
    await this.sendControl(record.peerId, { type: "file.cancel", transferId: record.transferId, reason: "cancelled_by_user" });
  }

  async getBlob(record: StoredAttachmentRecord): Promise<Blob> {
    return this.storage.getBlob(record.attachmentId, record.manifest);
  }

  async download(record: StoredAttachmentRecord): Promise<void> {
    if (record.state !== "completed" && record.direction !== "outgoing") {
      await this.requestDownload(record);
      return;
    }
    const blob = await this.getBlob(record);
    const url = URL.createObjectURL(blob);
    try {
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = sanitizeAttachmentFilename(record.manifest.filename);
      anchor.rel = "noopener";
      anchor.click();
    } finally { setTimeout(() => URL.revokeObjectURL(url), 30_000); }
  }

  async handleControlString(peerId: string, data: string): Promise<boolean> {
    if (!this.isAuthenticated(peerId)) return false;
    let value: unknown;
    try { value = JSON.parse(data); }
    catch { return false; }

    if (isFileControlMessage(value)) {
      await this.handleFileControl(peerId, value);
      return true;
    }
    if (isSyncWireMessage(value)) {
      await this.handleSync(peerId, value);
      return true;
    }
    return false;
  }

  async handleTransferFrame(peerId: string, data: ArrayBuffer): Promise<void> {
    if (!this.isAuthenticated(peerId)) return;
    const capabilities = this.peerCapabilities.get(peerId);
    if (!capabilities?.has("file-transfer-v1")) return;
    const frame = decodeAttachmentChunkFrame(data);
    await this.receiver.handleChunk(peerId, frame);
  }

  private async handleFileControl(peerId: string, message: FileControlMessage): Promise<void> {
    if (message.type === "peer.capabilities") {
      const supported = new Set(message.capabilities.filter((capability): capability is RiskCapability => LOCAL_CAPABILITIES.includes(capability)));
      this.peerCapabilities.set(peerId, supported);
      if (supported.has("file-transfer-v1")) this.transport.ensureTransferChannel(peerId);
      return;
    }
    if (message.type === "file.request") { await this.serveRequestedAttachment(peerId, message.attachmentId); return; }

    const transferId = "transferId" in message ? message.transferId : undefined;
    const outgoing = transferId ? this.outgoing.get(transferId) : undefined;
    if (outgoing) {
      switch (message.type) {
        case "file.accept": await this.sender.acceptAndStart(message.transferId); return;
        case "file.need": this.sender.resume(message.transferId, sanitizeChunkList(message.missingChunks)); return;
        case "file.pause": this.sender.pause(message.transferId); return;
        case "file.resume": this.sender.resume(message.transferId, message.missingChunks ? sanitizeChunkList(message.missingChunks) : undefined); return;
        case "file.cancel": this.sender.cancel(message.transferId); return;
        case "file.reject": this.sender.cancel(message.transferId); await this.markTransferError(message.transferId, message.reason ?? "Arquivo recusado pelo peer."); return;
        case "file.error": await this.markTransferError(message.transferId, message.message); return;
        case "file.complete": await this.markOutgoingVerified(message.transferId, message.contentHash); return;
        default: return;
      }
    }

    if (message.type === "file.offer") {
      if (message.manifest.senderPeerId !== peerId || message.manifest.channelId !== this.channelId) {
        await this.sendControl(peerId, { type: "file.reject", transferId: message.transferId, reason: "manifest_scope_mismatch" });
        return;
      }
    }
    await this.receiver.handleControl(peerId, message);
  }

  private async serveRequestedAttachment(peerId: string, attachmentId: string): Promise<void> {
    const capabilities = this.peerCapabilities.get(peerId);
    if (!capabilities?.has("file-transfer-v1") || !this.transport.isTransferChannelOpen(peerId)) {
      await this.sendControl(peerId, { type: "file.error", transferId: `request:${attachmentId}`, code: "transfer_unavailable", message: "O canal de transferência ainda não está disponível.", retryable: true });
      return;
    }
    const record = await this.storage.findCompletedByAttachmentId(attachmentId);
    if (!record || record.channelId !== this.channelId) {
      await this.sendControl(peerId, { type: "file.error", transferId: `request:${attachmentId}`, code: "attachment_unavailable", message: "Este peer não possui mais o arquivo solicitado.", retryable: false });
      return;
    }
    const source = this.sourceByAttachment.get(attachmentId) ?? await this.storage.getBlob(attachmentId, record.manifest);
    this.sourceByAttachment.set(attachmentId, source as TransferSource);
    const transferId = await this.sender.offer(peerId, source as TransferSource, record.manifest);
    this.outgoing.set(transferId, { peerId, attachmentId });
    await this.storage.registerOutgoing(transferId, this.channelId, peerId, record.manifest);
  }

  private async sendSyncHello(peerId: string): Promise<void> {
    const checkpoint = await getFromStore<SyncCheckpoint>(OFFLINE_STORES.syncCheckpoints, syncCheckpointId(peerId, this.channelId));
    await this.sendControl(peerId, {
      version: RISK_SYNC_PROTOCOL_VERSION,
      type: "sync.hello",
      requestId: crypto.randomUUID(),
      fromPeerId: this.localPeerId,
      scope: { channelId: this.channelId, entityKinds: ["attachment"] },
      checkpoint: checkpoint ? {
        revision: checkpoint.revision,
        cursor: checkpoint.cursor,
        stateHash: checkpoint.stateHash,
        lastSyncedAt: checkpoint.lastSyncedAt,
      } : undefined,
    } as SyncWireMessage);
  }

  private async handleSync(peerId: string, message: SyncWireMessage): Promise<void> {
    if (("channelId" in message && message.channelId !== this.channelId)
      || (message.type === "sync.hello" && message.scope.channelId !== this.channelId)) return;
    switch (message.type) {
      case "sync.hello": await this.sendSyncManifest(peerId, message.requestId); return;
      case "sync.manifest": await this.acceptSyncManifest(peerId, message); return;
      case "sync.need": await this.sendSyncItems(peerId, message.requestId, message.ids); return;
      case "sync.items": await this.acceptSyncItems(peerId, message); return;
      case "sync.checkpoint": await this.saveCheckpoint(peerId, message.revision, message.stateHash, message.cursor, message.timestamp); return;
      case "sync.complete": await this.saveCheckpoint(peerId, Date.now(), message.stateHash, undefined, message.timestamp); return;
    }
  }

  private async sendSyncManifest(peerId: string, requestId: string): Promise<void> {
    const descriptors = await this.localSyncDescriptors();
    const stateHash = await hashDescriptors(descriptors);
    const pages = Math.max(1, Math.ceil(descriptors.length / MAX_SYNC_DESCRIPTORS_PER_PAGE));
    for (let page = 0; page < pages; page += 1) {
      const start = page * MAX_SYNC_DESCRIPTORS_PER_PAGE;
      await this.sendControl(peerId, {
        version: RISK_SYNC_PROTOCOL_VERSION,
        type: "sync.manifest",
        requestId,
        channelId: this.channelId,
        page,
        hasMore: page + 1 < pages,
        cursor: String(start + MAX_SYNC_DESCRIPTORS_PER_PAGE),
        descriptors: descriptors.slice(start, start + MAX_SYNC_DESCRIPTORS_PER_PAGE),
        stateHash,
      } as SyncWireMessage);
    }
  }

  private async acceptSyncManifest(peerId: string, message: Extract<SyncWireMessage, { type: "sync.manifest" }>): Promise<void> {
    this.syncRequests.set(message.requestId, { peerId, stateHash: message.stateHash });
    const local = new Map((await this.storage.listChannel(this.channelId)).map((record) => [record.attachmentId, record.manifest.contentHash]));
    const missing = message.descriptors
      .filter((descriptor) => descriptor.kind === "attachment" && local.get(descriptor.id) !== descriptor.contentHash)
      .map((descriptor) => descriptor.id);
    for (let offset = 0; offset < missing.length; offset += MAX_SYNC_NEED_IDS) {
      await this.sendControl(peerId, {
        version: RISK_SYNC_PROTOCOL_VERSION,
        type: "sync.need",
        requestId: message.requestId,
        channelId: this.channelId,
        ids: missing.slice(offset, offset + MAX_SYNC_NEED_IDS),
      } as SyncWireMessage);
    }
    if (!message.hasMore && missing.length === 0) await this.completeSync(peerId, message.requestId, message.stateHash);
  }

  private async sendSyncItems(peerId: string, requestId: string, ids: string[]): Promise<void> {
    const records = await this.storage.listChannel(this.channelId);
    const available = records.filter((record) => ids.includes(record.attachmentId) && (record.direction === "outgoing" || record.state === "completed"));
    for (let offset = 0; offset < available.length; offset += MAX_SYNC_ITEMS_PER_MESSAGE) {
      await this.sendControl(peerId, {
        version: RISK_SYNC_PROTOCOL_VERSION,
        type: "sync.items",
        requestId,
        channelId: this.channelId,
        items: available.slice(offset, offset + MAX_SYNC_ITEMS_PER_MESSAGE).map((record) => ({
          descriptor: descriptorFor(record),
          payload: record.manifest,
        })),
      } as SyncWireMessage);
    }
  }

  private async acceptSyncItems(peerId: string, message: Extract<SyncWireMessage, { type: "sync.items" }>): Promise<void> {
    for (const item of message.items) {
      if (item.descriptor.kind !== "attachment") continue;
      const manifest = item.payload as AttachmentManifest;
      if (validateAttachmentManifest(manifest).length > 0 || manifest.channelId !== this.channelId || manifest.id !== item.descriptor.id) continue;
      const record = await this.storage.registerSyncedMetadata(peerId, manifest);
      this.emitRecord(record);
    }
    const request = this.syncRequests.get(message.requestId);
    if (request) await this.completeSync(peerId, message.requestId, request.stateHash);
  }

  private async completeSync(peerId: string, requestId: string, stateHash: string): Promise<void> {
    const timestamp = new Date().toISOString();
    await this.saveCheckpoint(peerId, Date.now(), stateHash, undefined, timestamp);
    await this.sendControl(peerId, {
      version: RISK_SYNC_PROTOCOL_VERSION,
      type: "sync.complete",
      requestId,
      channelId: this.channelId,
      stateHash,
      timestamp,
    } as SyncWireMessage);
    this.syncRequests.delete(requestId);
  }

  private async localSyncDescriptors(): Promise<SyncDescriptor[]> {
    const records = await this.storage.listChannel(this.channelId);
    const unique = new Map<string, StoredAttachmentRecord>();
    for (const record of records) {
      if (record.direction !== "outgoing" && record.state !== "completed") continue;
      if (!unique.has(record.attachmentId)) unique.set(record.attachmentId, record);
    }
    return [...unique.values()].map(descriptorFor).sort((left, right) => left.id.localeCompare(right.id));
  }

  private async saveCheckpoint(peerId: string, revision: number, stateHash: string, cursor: string | undefined, timestamp: string): Promise<void> {
    const checkpoint: SyncCheckpoint = {
      id: syncCheckpointId(peerId, this.channelId),
      remotePeerId: peerId,
      channelId: this.channelId,
      revision,
      cursor,
      stateHash,
      lastSyncedAt: timestamp,
    };
    await putInStore(OFFLINE_STORES.syncCheckpoints, checkpoint);
  }

  private async markOutgoingVerified(transferId: string, contentHash: string): Promise<void> {
    const record = await this.storage.findByTransferId(transferId);
    if (!record || record.manifest.contentHash.toLowerCase() !== contentHash.toLowerCase()) return;
    this.sender.confirm(transferId);
    const now = new Date().toISOString();
    const updated = { ...record, state: "completed" as const, bytesTransferred: record.totalBytes, completedAt: now, updatedAt: now };
    await this.storage.saveRecord(updated);
    this.emitRecord(updated);
    this.outgoing.delete(transferId);
  }

  private async markTransferError(transferId: string, error: string): Promise<void> {
    const record = await this.storage.findByTransferId(transferId);
    if (!record) return;
    const updated = { ...record, state: "failed" as const, lastError: error, updatedAt: new Date().toISOString() };
    await this.storage.saveRecord(updated);
    this.emitRecord(updated);
  }

  private async onProgress(progress: AttachmentTransferProgress): Promise<void> {
    const record = await this.storage.updateProgress(progress);
    if (!record) return;
    const now = Date.now();
    const previous = this.progressSamples.get(progress.transferId);
    const instantaneous = previous && now > previous.timestamp
      ? Math.max(0, (progress.bytesTransferred - previous.bytes) / ((now - previous.timestamp) / 1000))
      : 0;
    const speed = previous ? (previous.speed * 0.65) + (instantaneous * 0.35) : instantaneous;
    this.progressSamples.set(progress.transferId, { bytes: progress.bytesTransferred, timestamp: now, speed });
    const remaining = Math.max(0, progress.totalBytes - progress.bytesTransferred);
    const detail: AttachmentRuntimeState = {
      record,
      progressPercent: progress.totalBytes > 0 ? Math.min(100, (progress.bytesTransferred / progress.totalBytes) * 100) : 100,
      speedBytesPerSecond: speed,
      etaSeconds: speed > 0 && remaining > 0 ? remaining / speed : undefined,
    };
    this.dispatchEvent(new CustomEvent<AttachmentRuntimeState>("progress", { detail }));
    this.emitRecord(record);
  }

  private emitRecord(record: StoredAttachmentRecord): void {
    this.dispatchEvent(new CustomEvent<StoredAttachmentRecord>("attachment", { detail: record }));
  }

  private isAuthenticated(peerId: string): boolean { return this.authenticatedPeers().includes(peerId); }

  private async sendControl(peerId: string, message: FileControlMessage | SyncWireMessage): Promise<void> {
    const payload = JSON.stringify(message);
    if (this.transport.sendData(payload, peerId) === 0) throw new Error("Canal P2P de controle indisponível ou congestionado.");
  }
}

async function buildManifest(file: File, channelId: string, senderPeerId: string): Promise<AttachmentManifest> {
  const chunkSize = DEFAULT_ATTACHMENT_CHUNK_SIZE;
  const chunkCount = Math.ceil(file.size / chunkSize);
  const includeChunkHashes = chunkCount <= MAX_MANIFEST_CHUNK_HASHES;
  const chunkHashes = includeChunkHashes ? [] as string[] : undefined;
  const hasher = new IncrementalSha256();
  for (let index = 0; index < chunkCount; index += 1) {
    const offset = index * chunkSize;
    const payload = await file.slice(offset, Math.min(file.size, offset + chunkSize)).arrayBuffer();
    hasher.update(payload);
    if (chunkHashes) chunkHashes.push(await sha256Hex(payload));
  }
  const contentHash = hasher.digestHex();
  const filename = sanitizeAttachmentFilename(file.name || "attachment");
  return {
    protocolVersion: RISK_ATTACHMENT_PROTOCOL_VERSION,
    id: contentHash,
    messageId: crypto.randomUUID(),
    channelId,
    senderPeerId,
    filename,
    mimeType: file.type || "application/octet-stream",
    extension: extensionOf(filename),
    kind: classifyAttachment(file.type || "application/octet-stream", filename),
    size: file.size,
    contentHash,
    chunkSize,
    chunkCount,
    chunkHashes,
    createdAt: new Date().toISOString(),
  };
}

function descriptorFor(record: StoredAttachmentRecord): SyncDescriptor {
  return {
    id: record.attachmentId,
    kind: "attachment",
    revision: 1,
    contentHash: record.manifest.contentHash,
    updatedAt: record.updatedAt,
  };
}

async function hashDescriptors(descriptors: SyncDescriptor[]): Promise<string> {
  return sha256Hex(new TextEncoder().encode(descriptors.map((item) => `${item.kind}:${item.id}:${item.revision}:${item.contentHash}`).join("\n")));
}

function sanitizeChunkList(chunks: number[]): number[] {
  return [...new Set(chunks.filter((index) => Number.isSafeInteger(index) && index >= 0))].slice(0, 100_000);
}

function extensionOf(filename: string): string | undefined {
  const index = filename.lastIndexOf(".");
  return index > 0 && index < filename.length - 1 ? filename.slice(index + 1).toLowerCase() : undefined;
}
