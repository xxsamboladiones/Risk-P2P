import { loadLocalIdentity, updateLocalIdentityProfile, type LocalIdentity } from "./social-storage";

const MAX_AVATAR_SOURCE_BYTES = 8 * 1024 * 1024;
export const MAX_AVATAR_DATA_URL_BYTES = 32 * 1024;
const AVATAR_SIZE = 256;

export type LocalProfile = Pick<LocalIdentity, "displayName" | "avatar">;

export function validAvatarDataUrl(value: unknown): value is string {
  return typeof value === "string"
    && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/i.test(value)
    && new TextEncoder().encode(value).byteLength <= MAX_AVATAR_DATA_URL_BYTES;
}

export async function loadLocalProfile(): Promise<LocalProfile | null> {
  const identity = await loadLocalIdentity();
  return identity ? { displayName: identity.displayName, avatar: identity.avatar } : null;
}

export async function saveLocalProfile(displayName: string, avatar?: string): Promise<LocalProfile> {
  const name = displayName.trim();
  if (name.length < 2 || name.length > 80) throw new Error("O nome deve ter entre 2 e 80 caracteres.");
  if (avatar !== undefined && !validAvatarDataUrl(avatar)) throw new Error("A imagem de perfil é inválida ou muito grande.");
  const identity = await updateLocalIdentityProfile(name, avatar);
  return { displayName: identity.displayName, avatar: identity.avatar };
}

export async function avatarFromFile(file: File): Promise<string> {
  if (!/^image\/(?:png|jpeg|webp)$/i.test(file.type)) throw new Error("Escolha uma imagem PNG, JPEG ou WebP.");
  if (file.size > MAX_AVATAR_SOURCE_BYTES) throw new Error("A imagem original deve ter no máximo 8 MB.");

  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = AVATAR_SIZE;
    canvas.height = AVATAR_SIZE;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("Não foi possível preparar a imagem de perfil.");

    const side = Math.min(bitmap.width, bitmap.height);
    const sourceX = Math.max(0, (bitmap.width - side) / 2);
    const sourceY = Math.max(0, (bitmap.height - side) / 2);
    context.fillStyle = "#11161e";
    context.fillRect(0, 0, AVATAR_SIZE, AVATAR_SIZE);
    context.drawImage(bitmap, sourceX, sourceY, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE);

    for (const quality of [0.86, 0.72, 0.58, 0.44]) {
      const blob = await canvasBlob(canvas, "image/webp", quality);
      const dataUrl = await blobDataUrl(blob);
      if (validAvatarDataUrl(dataUrl)) return dataUrl;
    }
    throw new Error("Não foi possível reduzir a imagem ao tamanho seguro para o perfil P2P.");
  } finally {
    bitmap.close();
  }
}

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob(
    (blob) => blob ? resolve(blob) : reject(new Error("Falha ao converter a imagem de perfil.")),
    type,
    quality,
  ));
}

function blobDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("Falha ao ler a imagem de perfil."));
    reader.onerror = () => reject(reader.error ?? new Error("Falha ao ler a imagem de perfil."));
    reader.readAsDataURL(blob);
  });
}
