export const MAX_AVATAR_DATA_URL_BYTES = 32 * 1024;

export function validAvatarDataUrl(value: unknown): value is string {
  return typeof value === "string"
    && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/i.test(value)
    && new TextEncoder().encode(value).byteLength <= MAX_AVATAR_DATA_URL_BYTES;
}
