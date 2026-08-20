import {
  validateAttachmentManifest,
  type AttachmentChunkFrame,
  type AttachmentManifest,
  type AttachmentTransferProgress,
  type FileControlMessage,
  type FileOfferMessage,
} from "@risk/protocol/attachments";
import { verifyAttachmentChunk, type TransferSendControl } from "./file-transfer";

export interface AttachmentChunkSink {
  prepare(transferId: string, manifest: AttachmentManifest): Promise<void>;
  hasChunk(transferId: string, index: number): Promise<boolean>;
  writeChunk(transferId: string, frame: AttachmentChunkFrame): Promise<void>;
  finalize(transferId: string, manifest: AttachmentManifest): Promise<{ contentHash: string }>;
  discard(transferId: string): Promise<void>;
}

export type AttachmentTransferReceiverOptions = {
  maxIncomingTransfers?: number;
  maxFileSizeBytes?: number;
  autoAccept?: (peerId: string, manifest: AttachmentManifest) => boolean | Promise<boolean>;
};

type IncomingTransfer = {
  peerId: string;
  transferId: string;
  manifest: AttachmentManifest;
  receivedChunks: Set<number>;
  bytesTransferred: number;
  state: AttachmentTransferProgress["state"];
  startedAt?: string;
  retryCount: number;
};

const DEFAULT_MAX_INCOMING_TRANSFERS = 4;
const DEFAULT_MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024 * 1024;
const MAX_MISSING_CHUNKS_PER_REQUEST = 2_048;

export class AttachmentTransferReceiver extends EventTarget {
  private readonly transfers = new Map<string, IncomingTransfer>();
  private readonly maxIncomingTransfers: number;
  private readonly maxFileSizeBytes: number;

  constructor(
    private readonly sink: AttachmentChunkSink,
    private readonly sendControl: TransferSendControl,
    private readonly options: AttachmentTransferReceiverOptions = {},
  ) {
    super();
    this.maxIncomingTransfers = options.maxIncomingTransfers ?? DEFAULT_MAX_INCOMING_TRANSFERS;
    this.maxFileSizeBytes = options.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES;
  }

  async handleControl(peerId: string, message: FileControlMessage): Promise<void> {
    switch (message.type) {
      case "file.offer":
        await this.handleOffer(peerId, message);
        return;
      case "file.manifest":
        await this.ensurePrepared(peerId, message.transferId, message.manifest);
        return;
      case "file.pause":
        this.updateState(message.transferId, "paused");
        return;
      case "file.resume":
        this.updateState(message.transferId, "transferring");
        return;
      case "file.cancel":
        await this.cancel(message.transferId);
        return;
      case "file.complete":
        await this.complete(peerId, message.transferId, message.contentHash);
        return;
      default:
        return;
    }
  }

  async handleChunk(peerId: string, frame: AttachmentChunkFrame): Promise<void> {
    const transfer = this.transfers.get(frame.transferId);
    if (!transfer || transfer.peerId !== peerId) throw new Error("Chunk recebido para transferência desconhecida.");
    if (transfer.state === "paused" || transfer.state === "cancelled" || transfer.state === "failed") return;
    if (frame.attachmentId !== transfer.manifest.id) throw new Error("attachmentId divergente no chunk.");
    if (frame.index < 0 || frame.index >= transfer.manifest.chunkCount) throw new Error("Índice de chunk fora do manifesto.");

    const expectedHash = transfer.manifest.chunkHashes?.[frame.index];
    if (expectedHash && expectedHash.toLowerCase() !== frame.hash.toLowerCase()) {
      transfer.retryCount += 1;
      await this.requestMissing(peerId, transfer, [frame.index]);
      return;
    }
    if (!(await verifyAttachmentChunk(frame))) {
      transfer.retryCount += 1;
      await this.requestMissing(peerId, transfer, [frame.index]);
      return;
    }
    if (await this.sink.hasChunk(frame.transferId, frame.index)) {
      transfer.receivedChunks.add(frame.index);
      return;
    }

    await this.sink.writeChunk(frame.transferId, frame);
    transfer.receivedChunks.add(frame.index);
    transfer.bytesTransferred += frame.size;
    transfer.state = "transferring";
    transfer.startedAt ??= new Date().toISOString();
    this.emitProgress(transfer);
  }

  async accept(transferId: string): Promise<void> {
    const transfer = this.requireTransfer(transferId);
    await this.sink.prepare(transferId, transfer.manifest);
    transfer.state = "accepted";
    const missing = await this.getMissingChunks(transfer);
    if (missing.length === transfer.manifest.chunkCount) {
      await this.sendControl(transfer.peerId, { type: "file.accept", transferId });
    } else {
      await this.requestMissing(transfer.peerId, transfer, missing);
    }
    transfer.state = "transferring";
    this.emitProgress(transfer);
  }

  async reject(transferId: string, reason?: string): Promise<void> {
    const transfer = this.requireTransfer(transferId);
    await this.sendControl(transfer.peerId, { type: "file.reject", transferId, reason });
    await this.sink.discard(transferId);
    transfer.state = "cancelled";
    this.emitProgress(transfer);
    this.transfers.delete(transferId);
  }

  async cancel(transferId: string): Promise<void> {
    const transfer = this.transfers.get(transferId);
    if (!transfer) return;
    await this.sink.discard(transferId);
    transfer.state = "cancelled";
    this.emitProgress(transfer);
    this.transfers.delete(transferId);
  }

  async getMissingChunksForResume(transferId: string): Promise<number[]> {
    return this.getMissingChunks(this.requireTransfer(transferId));
  }

  private async handleOffer(peerId: string, message: FileOfferMessage): Promise<void> {
    if (this.transfers.has(message.transferId)) return;
    if (this.transfers.size >= this.maxIncomingTransfers) {
      await this.sendControl(peerId, { type: "file.reject", transferId: message.transferId, reason: "too_many_transfers" });
      return;
    }
    const errors = validateAttachmentManifest(message.manifest);
    if (errors.length > 0 || message.manifest.size > this.maxFileSizeBytes) {
      await this.sendControl(peerId, {
        type: "file.reject",
        transferId: message.transferId,
        reason: errors.length > 0 ? errors.join(",") : "file_too_large",
      });
      return;
    }

    const transfer: IncomingTransfer = {
      peerId,
      transferId: message.transferId,
      manifest: message.manifest,
      receivedChunks: new Set(),
      bytesTransferred: 0,
      state: "offered",
      retryCount: 0,
    };
    this.transfers.set(message.transferId, transfer);
    this.emitOffer(transfer);

    if (this.options.autoAccept && await this.options.autoAccept(peerId, message.manifest)) {
      await this.accept(message.transferId);
    }
  }

  private async ensurePrepared(peerId: string, transferId: string, manifest: AttachmentManifest): Promise<void> {
    const existing = this.transfers.get(transferId);
    if (existing) {
      if (existing.peerId !== peerId || existing.manifest.contentHash !== manifest.contentHash) {
        throw new Error("Manifesto divergente para transferência existente.");
      }
      return;
    }
    await this.handleOffer(peerId, { type: "file.offer", transferId, manifest });
  }

  private async complete(peerId: string, transferId: string, announcedHash: string): Promise<void> {
    const transfer = this.requireTransfer(transferId);
    if (transfer.peerId !== peerId) throw new Error("Peer divergente ao finalizar transferência.");
    const missing = await this.getMissingChunks(transfer);
    if (missing.length > 0) {
      await this.requestMissing(peerId, transfer, missing);
      return;
    }

    transfer.state = "verifying";
    this.emitProgress(transfer);
    try {
      const result = await this.sink.finalize(transferId, transfer.manifest);
      if (result.contentHash.toLowerCase() !== transfer.manifest.contentHash.toLowerCase() || result.contentHash.toLowerCase() !== announcedHash.toLowerCase()) {
        throw new Error("Hash final do arquivo não confere com o manifesto.");
      }
      transfer.bytesTransferred = transfer.manifest.size;
      transfer.state = "completed";
      this.emitProgress(transfer);
      await this.sendControl(peerId, { type: "file.complete", transferId, contentHash: result.contentHash });
      this.transfers.delete(transferId);
    } catch (error) {
      transfer.state = "failed";
      this.emitProgress(transfer, error instanceof Error ? error.message : String(error));
      await this.sendControl(peerId, {
        type: "file.error",
        transferId,
        code: "integrity_check_failed",
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
      });
    }
  }

  private async requestMissing(peerId: string, transfer: IncomingTransfer, missingChunks: number[]): Promise<void> {
    await this.sendControl(peerId, {
      type: "file.need",
      transferId: transfer.transferId,
      missingChunks: missingChunks.slice(0, MAX_MISSING_CHUNKS_PER_REQUEST),
    });
  }

  private async getMissingChunks(transfer: IncomingTransfer): Promise<number[]> {
    const missing: number[] = [];
    for (let index = 0; index < transfer.manifest.chunkCount; index += 1) {
      if (transfer.receivedChunks.has(index) || await this.sink.hasChunk(transfer.transferId, index)) continue;
      missing.push(index);
    }
    return missing;
  }

  private updateState(transferId: string, state: AttachmentTransferProgress["state"]): void {
    const transfer = this.transfers.get(transferId);
    if (!transfer) return;
    transfer.state = state;
    this.emitProgress(transfer);
  }

  private requireTransfer(transferId: string): IncomingTransfer {
    const transfer = this.transfers.get(transferId);
    if (!transfer) throw new Error(`Transferência recebida desconhecida: ${transferId}`);
    return transfer;
  }

  private emitOffer(transfer: IncomingTransfer): void {
    this.dispatchEvent(new CustomEvent("offer", {
      detail: { transferId: transfer.transferId, peerId: transfer.peerId, manifest: transfer.manifest },
    }));
    this.emitProgress(transfer);
  }

  private emitProgress(transfer: IncomingTransfer, lastError?: string): void {
    const detail: AttachmentTransferProgress = {
      transferId: transfer.transferId,
      attachmentId: transfer.manifest.id,
      peerId: transfer.peerId,
      state: transfer.state,
      bytesTransferred: transfer.bytesTransferred,
      totalBytes: transfer.manifest.size,
      retryCount: transfer.retryCount,
      startedAt: transfer.startedAt,
      updatedAt: new Date().toISOString(),
      lastError,
    };
    this.dispatchEvent(new CustomEvent<AttachmentTransferProgress>("progress", { detail }));
  }
}
