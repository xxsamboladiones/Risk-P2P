import { describe, expect, it, vi } from "vitest";
import {
  clipboardImageFiles,
  confirmPendingAttachments,
  removePendingAttachment,
  revokePendingAttachments,
  stageAttachmentFiles,
} from "./message-composer-attachments";

function clipboardItem(file: File | null, kind = "file", type = file?.type ?? ""): DataTransferItem {
  return { kind, type, getAsFile: () => file } as DataTransferItem;
}

describe("message composer attachments", () => {
  it("preserva o contexto das APIs nativas ao criar e remover uma prévia", () => {
    const createObjectUrl = vi.spyOn(URL, "createObjectURL").mockImplementation(function (this: typeof URL) {
      if (this !== URL) throw new TypeError("Illegal invocation");
      return "blob:native";
    });
    const revokeObjectUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(function (this: typeof URL) {
      if (this !== URL) throw new TypeError("Illegal invocation");
    });
    const randomUUID = vi.spyOn(crypto, "randomUUID").mockImplementation(function (this: Crypto) {
      if (this !== crypto) throw new TypeError("Illegal invocation");
      return "00000000-0000-4000-8000-000000000001";
    });

    try {
      const pending = stageAttachmentFiles([new File(["pixels"], "image.png", { type: "image/png" })]);
      expect(pending[0]?.previewUrl).toBe("blob:native");
      expect(removePendingAttachment(pending, pending[0]!.id)).toEqual([]);
      expect(createObjectUrl).toHaveBeenCalledOnce();
      expect(revokeObjectUrl).toHaveBeenCalledWith("blob:native");
      expect(randomUUID).toHaveBeenCalledOnce();
    } finally {
      createObjectUrl.mockRestore();
      revokeObjectUrl.mockRestore();
      randomUUID.mockRestore();
    }
  });

  it("extracts only image files from the clipboard", () => {
    const image = new File(["pixels"], "", { type: "image/png" });
    const document = new File(["text"], "notes.txt", { type: "text/plain" });

    const files = clipboardImageFiles([
      clipboardItem(image),
      clipboardItem(document),
      clipboardItem(null, "string", "text/plain"),
    ]);

    expect(files).toHaveLength(1);
    expect(files[0]?.type).toBe("image/png");
    expect(files[0]?.name).toMatch(/^imagem-colada-\d+\.png$/);
  });

  it("recognizes a clipboard image from the file MIME when the item MIME is empty", () => {
    const image = new File(["pixels"], "", { type: "image/webp" });

    const files = clipboardImageFiles([clipboardItem(image, "file", "")]);

    expect(files).toHaveLength(1);
    expect(files[0]?.name).toMatch(/\.webp$/);
  });

  it("stages image previews and keeps other selected files for confirmation", () => {
    const createObjectUrl = vi.fn((file: Blob) => `blob:${file.type}`);
    const files = [
      new File(["pixels"], "photo.webp", { type: "image/webp" }),
      new File(["archive"], "save.zip", { type: "application/zip" }),
    ];

    const pending = stageAttachmentFiles(files, createObjectUrl, vi.fn()
      .mockReturnValueOnce("image-id")
      .mockReturnValueOnce("file-id"));

    expect(pending).toEqual([
      { id: "image-id", file: files[0], previewUrl: "blob:image/webp" },
      { id: "file-id", file: files[1], previewUrl: undefined },
    ]);
    expect(createObjectUrl).toHaveBeenCalledOnce();
  });

  it("removes one pending file and revokes its image preview", () => {
    const revokeObjectUrl = vi.fn();
    const files = [
      { id: "first", file: new File(["a"], "a.png", { type: "image/png" }), previewUrl: "blob:first" },
      { id: "second", file: new File(["b"], "b.txt", { type: "text/plain" }), previewUrl: undefined },
    ];

    const remaining = removePendingAttachment(files, "first", revokeObjectUrl);

    expect(remaining.map(({ id }) => id)).toEqual(["second"]);
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:first");
  });

  it("revokes every image preview when confirmed or unmounted", () => {
    const revokeObjectUrl = vi.fn();
    const files = [
      { id: "first", file: new File(["a"], "a.png", { type: "image/png" }), previewUrl: "blob:first" },
      { id: "second", file: new File(["b"], "b.jpg", { type: "image/jpeg" }), previewUrl: "blob:second" },
    ];

    revokePendingAttachments(files, revokeObjectUrl);

    expect(revokeObjectUrl.mock.calls).toEqual([["blob:first"], ["blob:second"]]);
  });

  it("sends every pending file and releases previews only after confirmation succeeds", async () => {
    let finishSend!: () => void;
    const sending = new Promise<void>((resolve) => { finishSend = resolve; });
    const onFiles = vi.fn(() => sending);
    const revokeObjectUrl = vi.fn();
    const pending = [
      { id: "first", file: new File(["a"], "a.png", { type: "image/png" }), previewUrl: "blob:first" },
      { id: "second", file: new File(["b"], "b.png", { type: "image/png" }), previewUrl: "blob:second" },
    ];

    const confirmation = confirmPendingAttachments(pending, onFiles, revokeObjectUrl);
    expect(onFiles).toHaveBeenCalledWith([pending[0]?.file]);
    expect(revokeObjectUrl).not.toHaveBeenCalled();

    finishSend();
    await expect(confirmation).resolves.toEqual(["first", "second"]);
    expect(onFiles.mock.calls).toEqual([[[pending[0]?.file]], [[pending[1]?.file]]]);
    expect(revokeObjectUrl.mock.calls).toEqual([["blob:first"], ["blob:second"]]);
  });

  it("keeps previews alive when attachment sending fails", async () => {
    const revokeObjectUrl = vi.fn();
    const pending = [
      { id: "first", file: new File(["a"], "a.png", { type: "image/png" }), previewUrl: "blob:first" },
    ];

    await expect(confirmPendingAttachments(
      pending,
      async () => { throw new Error("offline"); },
      revokeObjectUrl,
    )).rejects.toThrow("offline");
    expect(revokeObjectUrl).not.toHaveBeenCalled();
  });

  it("clears files already sent while retaining the file that failed", async () => {
    const onFiles = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("offline"));
    const revokeObjectUrl = vi.fn();
    const onConfirmed = vi.fn();
    const pending = [
      { id: "first", file: new File(["a"], "a.png", { type: "image/png" }), previewUrl: "blob:first" },
      { id: "second", file: new File(["b"], "b.png", { type: "image/png" }), previewUrl: "blob:second" },
    ];

    await expect(confirmPendingAttachments(pending, onFiles, revokeObjectUrl, onConfirmed)).rejects.toThrow("offline");

    expect(onFiles.mock.calls).toEqual([[[pending[0]?.file]], [[pending[1]?.file]]]);
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:first");
    expect(revokeObjectUrl).not.toHaveBeenCalledWith("blob:second");
    expect(onConfirmed).toHaveBeenCalledWith("first");
    expect(onConfirmed).not.toHaveBeenCalledWith("second");
  });
});
