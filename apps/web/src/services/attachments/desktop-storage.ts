import type { AttachmentChunkFrame, AttachmentManifest } from "@risk/protocol/attachments";
import { IndexedDbAttachmentStorage, type StoredAttachmentRecord } from "./indexeddb-storage";

export type DesktopAttachmentBackendConfig = { baseUrl: string; token: string };

export class DesktopAttachmentStorage extends IndexedDbAttachmentStorage {
  constructor(private readonly config: DesktopAttachmentBackendConfig) { super(); }

  override async prepare(transferId: string, manifest: AttachmentManifest): Promise<void> {
    await super.prepare(transferId, manifest);
    await this.prepareRustTransfer(transferId, manifest);
  }

  override async hasChunk(transferId: string, index: number): Promise<boolean> {
    const response = await this.request(`/p2p/attachments/${encodeURIComponent(transferId)}/chunks/${index}`);
    const value = await response.json() as { exists?: unknown };
    return value.exists === true;
  }

  override async writeChunk(transferId: string, frame: AttachmentChunkFrame): Promise<void> {
    await this.request(`/p2p/attachments/${encodeURIComponent(transferId)}/chunks/${frame.index}`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: frame.payload,
    });
  }

  override async finalize(transferId: string, manifest: AttachmentManifest): Promise<{ contentHash: string }> {
    const response = await this.request(`/p2p/attachments/${encodeURIComponent(transferId)}/finalize`, { method: "POST" });
    const result = await response.json() as { contentHash?: unknown };
    if (typeof result.contentHash !== "string") throw new Error("Backend Rust não retornou o hash final do anexo.");
    const record = await this.findByTransferId(transferId);
    if (record) {
      const now = new Date().toISOString();
      await this.saveRecord({ ...record, state: "completed", bytesTransferred: manifest.size, updatedAt: now, completedAt: now });
    }
    return { contentHash: result.contentHash };
  }

  override async discard(transferId: string): Promise<void> {
    await this.request(`/p2p/attachments/${encodeURIComponent(transferId)}/discard`, { method: "POST" }).catch(() => undefined);
    await super.discard(transferId);
  }

  override async persistOutgoingSource(
    transferId: string,
    channelId: string,
    peerId: string,
    source: Blob,
    manifest: AttachmentManifest,
  ): Promise<StoredAttachmentRecord> {
    const record = await this.registerOutgoing(transferId, channelId, peerId, manifest);
    await this.prepareRustTransfer(transferId, manifest);
    for (let index = 0; index < manifest.chunkCount; index += 1) {
      const offset = index * manifest.chunkSize;
      const payload = await source.slice(offset, Math.min(source.size, offset + manifest.chunkSize)).arrayBuffer();
      await this.request(`/p2p/attachments/${encodeURIComponent(transferId)}/chunks/${index}`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: payload,
      });
    }
    const response = await this.request(`/p2p/attachments/${encodeURIComponent(transferId)}/finalize`, { method: "POST" });
    const result = await response.json() as { contentHash?: unknown };
    if (typeof result.contentHash !== "string" || result.contentHash.toLowerCase() !== manifest.contentHash.toLowerCase()) {
      throw new Error("Cópia persistente do anexo falhou na verificação SHA-256.");
    }
    return record;
  }

  override async getBlob(attachmentId: string, manifest?: AttachmentManifest): Promise<Blob> {
    const response = await this.request(`/p2p/attachments/content/${encodeURIComponent(attachmentId)}`);
    const blob = await response.blob();
    if (manifest && blob.size !== manifest.size) throw new Error("Arquivo salvo no backend possui tamanho divergente.");
    return blob;
  }

  private async prepareRustTransfer(transferId: string, manifest: AttachmentManifest): Promise<void> {
    await this.request(`/p2p/attachments/${encodeURIComponent(transferId)}/prepare`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        attachmentId: manifest.id,
        filename: manifest.filename,
        mimeType: manifest.mimeType,
        size: manifest.size,
        chunkSize: manifest.chunkSize,
        chunkCount: manifest.chunkCount,
        contentHash: manifest.contentHash,
      }),
    });
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("x-risk-desktop-token", this.config.token);
    const response = await fetch(`${this.config.baseUrl}${path}`, { ...init, headers });
    if (!response.ok) {
      let message = `Backend local retornou HTTP ${response.status}.`;
      try {
        const payload = await response.json() as { message?: unknown };
        if (typeof payload.message === "string") message = payload.message;
      } catch { /* resposta não JSON */ }
      throw new Error(message);
    }
    return response;
  }
}

export async function createAttachmentStorage(): Promise<IndexedDbAttachmentStorage> {
  const bridge = window.desktop;
  if (!bridge?.getBackendConfig) return new IndexedDbAttachmentStorage();
  try {
    return new DesktopAttachmentStorage(await bridge.getBackendConfig());
  } catch (error) {
    console.warn("Backend Rust de anexos indisponível; usando IndexedDB.", error);
    return new IndexedDbAttachmentStorage();
  }
}
