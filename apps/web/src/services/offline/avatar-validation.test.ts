import { describe, expect, it } from "vitest";
import { MAX_AVATAR_DATA_URL_BYTES, validAvatarDataUrl } from "./avatar-validation";

describe("validação de imagens P2P", () => {
  it("mantém compatibilidade com imagens abaixo de 32 KB", () => {
    const compatible = `data:image/webp;base64,${"A".repeat(20 * 1024)}`;
    expect(validAvatarDataUrl(compatible)).toBe(true);
  });

  it("rejeita formatos não permitidos e payloads acima do limite", () => {
    expect(validAvatarDataUrl("data:image/svg+xml;base64,PHN2Zz4=" )).toBe(false);
    const excessive = `data:image/webp;base64,${"A".repeat(MAX_AVATAR_DATA_URL_BYTES)}`;
    expect(validAvatarDataUrl(excessive)).toBe(false);
  });
});
