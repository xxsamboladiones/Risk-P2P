import { describe, expect, it } from "vitest";
import type { AttachmentManifest } from "@risk/protocol/attachments";
import type { MeshWebRTCTransport } from "@risk/rtc";
import { AttachmentService, type AttachmentStorage } from "./attachment-service";
import type { StoredAttachmentRecord } from "./indexeddb-storage";

const attachmentId = "a".repeat(64);
const manifest: AttachmentManifest = {
  protocolVersion: 1,
  id: attachmentId,
  channelId: "channel_12345678",
  senderPeerId: "peer_12345678",
  filename: "arquivo.bin",
  mimeType: "application/octet-stream",
  kind: "other",
  size: 64,
  contentHash: attachmentId,
  chunkSize: 64,
  chunkCount: 1,
  createdAt: new Date(0).toISOString(),
};

function record(): StoredAttachmentRecord {
  return {
    recordId: `channel_12345678:${attachmentId}:sync:peer_12345678:${attachmentId}`,
    attachmentId,
    transferId: `sync:peer_12345678:${attachmentId}`,
    channelId: "channel_12345678",
    peerId: "peer_12345678",
    direction: "incoming",
    manifest,
    state: "waiting",
    bytesTransferred: 0,
    totalBytes: 64,
    retryCount: 0,
    createdAt: manifest.createdAt,
    updatedAt: manifest.createdAt,
  };
}

describe("AttachmentService request errors", () => {
  it("marks a synchronized attachment as failed when the source no longer has it", async () => {
    let current = record();
    const storage: AttachmentStorage = {
      prepare: async () => undefined,
      hasChunk: async () => false,
      writeChunk: async () => undefined,
      finalize: async () => ({ contentHash: attachmentId }),
      discard: async () => undefined,
      persistOutgoingSource: async () => current,
      registerOutgoing: async () => current,
      registerSyncedMetadata: async () => current,
      updateProgress: async () => current,
      listChannel: async () => [current],
      findByTransferId: async () => current,
      findAnyByAttachmentId: async () => current,
      findCompletedByAttachmentId: async () => undefined,
      getBlob: async () => new Blob(),
      saveRecord: async (next) => { current = next; },
    };
    const transport = {
      sendData: () => 1,
      sendTransferData: () => 1,
      waitForTransferBufferedAmountLow: async () => undefined,
      getTransferBufferedAmount: () => 0,
      isTransferChannelOpen: () => true,
      ensureTransferChannel: () => undefined,
    } as unknown as MeshWebRTCTransport;
    const service = new AttachmentService(transport, "channel_12345678", "self_12345678", () => ["peer_12345678"], storage);

    await service.handleControlString("peer_12345678", JSON.stringify({
      type: "file.error",
      transferId: `request:${attachmentId}`,
      code: "attachment_unavailable",
      message: "Arquivo removido no peer remoto.",
      retryable: false,
    }));

    expect(current.state).toBe("failed");
    expect(current.lastError).toBe("Arquivo removido no peer remoto.");
  });
});
