import { describe, expect, it } from "vitest";
import {
  RISK_ATTACHMENT_PROTOCOL_VERSION,
  classifyAttachment,
  inferAttachmentMimeType,
  sanitizeAttachmentFilename,
  validateAttachmentManifest,
  type AttachmentManifest,
} from "./attachments";

function manifest(overrides: Partial<AttachmentManifest> = {}): AttachmentManifest {
  return {
    protocolVersion: RISK_ATTACHMENT_PROTOCOL_VERSION,
    id: "a".repeat(64),
    senderPeerId: "peer_12345678",
    filename: "arquivo.zip",
    mimeType: "application/zip",
    kind: "archive",
    size: 64,
    contentHash: "a".repeat(64),
    chunkSize: 64,
    chunkCount: 1,
    createdAt: new Date(0).toISOString(),
    ...overrides,
  };
}

describe("attachment protocol validation", () => {
  it("accepts a bounded valid manifest", () => {
    expect(validateAttachmentManifest(manifest())).toEqual([]);
  });

  it("rejects invalid hashes and chunk counts", () => {
    expect(validateAttachmentManifest(manifest({ contentHash: "nope", chunkCount: -1 }))).toEqual(
      expect.arrayContaining(["invalid_content_hash", "invalid_chunk_count"]),
    );
  });

  it("removes path traversal and reserved filename characters", () => {
    expect(sanitizeAttachmentFilename("../../bad<name>.exe")).toBe("bad_name_.exe");
  });

  it("infers image MIME and kind from extension when the picker omits MIME", () => {
    expect(inferAttachmentMimeType("", "captura.PNG")).toBe("image/png");
    expect(inferAttachmentMimeType("application/octet-stream", "foto.jpeg")).toBe("image/jpeg");
    expect(classifyAttachment("application/octet-stream", "foto.jpeg")).toBe("image");
  });

  it("keeps a specific MIME supplied by the platform", () => {
    expect(inferAttachmentMimeType("image/webp", "foto.bin")).toBe("image/webp");
    expect(classifyAttachment("image/webp", "foto.bin")).toBe("image");
  });
});
