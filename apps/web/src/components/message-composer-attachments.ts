export type PendingComposerAttachment = {
  id: string;
  file: File;
  previewUrl?: string;
};

type ClipboardFileItem = Pick<DataTransferItem, "kind" | "type" | "getAsFile">;

const IMAGE_EXTENSION_BY_MIME: Readonly<Record<string, string>> = {
  "image/avif": "avif",
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/svg+xml": "svg",
  "image/webp": "webp",
};

export function clipboardImageFiles(items: ArrayLike<ClipboardFileItem> | readonly ClipboardFileItem[]): File[] {
  const files: File[] = [];
  for (const item of Array.from(items)) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    const mimeType = file?.type || item.type;
    if (!file || !mimeType.toLowerCase().startsWith("image/")) continue;
    files.push(file.name ? file : nameClipboardImage(file));
  }
  return files;
}

export function stageAttachmentFiles(
  files: readonly File[],
  createObjectUrl: (blob: Blob) => string = (blob) => URL.createObjectURL(blob),
  createId: () => string = () => crypto.randomUUID(),
): PendingComposerAttachment[] {
  return files.map((file) => ({
    id: createId(),
    file,
    previewUrl: file.type.toLowerCase().startsWith("image/") ? createObjectUrl(file) : undefined,
  }));
}

export function removePendingAttachment(
  pending: readonly PendingComposerAttachment[],
  id: string,
  revokeObjectUrl: (url: string) => void = (url) => URL.revokeObjectURL(url),
): PendingComposerAttachment[] {
  const removed = pending.find((item) => item.id === id);
  if (removed?.previewUrl) revokeObjectUrl(removed.previewUrl);
  return pending.filter((item) => item.id !== id);
}

export function revokePendingAttachments(
  pending: readonly PendingComposerAttachment[],
  revokeObjectUrl: (url: string) => void = (url) => URL.revokeObjectURL(url),
): void {
  for (const item of pending) {
    if (item.previewUrl) revokeObjectUrl(item.previewUrl);
  }
}

export async function confirmPendingAttachments(
  pending: readonly PendingComposerAttachment[],
  onFiles: (files: File[]) => Promise<void>,
  revokeObjectUrl: (url: string) => void = (url) => URL.revokeObjectURL(url),
  onConfirmed?: (id: string) => void,
): Promise<string[]> {
  const confirmed: string[] = [];
  for (const item of pending) {
    await onFiles([item.file]);
    if (item.previewUrl) revokeObjectUrl(item.previewUrl);
    confirmed.push(item.id);
    onConfirmed?.(item.id);
  }
  return confirmed;
}

function nameClipboardImage(file: File): File {
  const extension = IMAGE_EXTENSION_BY_MIME[file.type.toLowerCase()] ?? "png";
  return new File([file], `imagem-colada-${Date.now()}.${extension}`, {
    type: file.type,
    lastModified: file.lastModified || Date.now(),
  });
}
