import { describe, expect, it } from "vitest";
import { decodeAttachmentChunkFrame, encodeAttachmentChunkFrame, isAttachmentChunkFrame } from "./file-chunk-codec";

const HASH = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

describe("attachment binary chunk codec", () => {
  it("round-trips metadata and binary payload without base64", () => {
    const payload = new Uint8Array([0, 1, 2, 3, 127, 128, 254, 255]).buffer;
    const encoded = encodeAttachmentChunkFrame({
      transferId: "transfer_12345678",
      attachmentId: "attachment_12345678",
      index: 7,
      offset: 448,
      size: payload.byteLength,
      hash: HASH,
      payload,
    });

    expect(isAttachmentChunkFrame(encoded)).toBe(true);
    const decoded = decodeAttachmentChunkFrame(encoded);
    expect(decoded.transferId).toBe("transfer_12345678");
    expect(decoded.attachmentId).toBe("attachment_12345678");
    expect(decoded.index).toBe(7);
    expect(decoded.offset).toBe(448);
    expect(decoded.hash).toBe(HASH);
    expect([...new Uint8Array(decoded.payload)]).toEqual([0, 1, 2, 3, 127, 128, 254, 255]);
  });

  it("rejects truncated frames", () => {
    const truncated = new ArrayBuffer(8);
    expect(isAttachmentChunkFrame(truncated)).toBe(false);
    expect(() => decodeAttachmentChunkFrame(truncated)).toThrow(/truncado/i);
  });

  it("rejects inconsistent payload size", () => {
    const payload = new Uint8Array([1, 2, 3]).buffer;
    expect(() => encodeAttachmentChunkFrame({
      transferId: "transfer_12345678",
      attachmentId: "attachment_12345678",
      index: 0,
      offset: 0,
      size: 2,
      hash: HASH,
      payload,
    })).toThrow(/tamanho/i);
  });
});
