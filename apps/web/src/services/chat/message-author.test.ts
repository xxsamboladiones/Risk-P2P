import { describe, expect, it } from "vitest";
import { resolveMessageAuthor } from "./message-author";

describe("fotos dos autores de mensagens", () => {
  const profiles = [
    { peerId: "a", displayName: "Ana", avatar: "data:image/png;base64,AA==" },
    { peerId: "b", displayName: "Ana", avatar: "data:image/png;base64,BB==" },
  ];
  it("usa a identidade assinada mesmo com nomes iguais ou alterados", () => {
    expect(resolveMessageAuthor({ author: "Nome antigo", authorPeerId: "b" }, profiles)).toEqual(profiles[1]);
  });
  it("recupera a foto de uma mensagem legada com nome único", () => {
    expect(resolveMessageAuthor({ author: " ana " }, profiles.slice(0, 1))).toEqual(profiles[0]);
  });
  it("não atribui foto a nomes ambíguos nem a outra identidade", () => {
    expect(resolveMessageAuthor({ author: "Ana" }, profiles).avatar).toBeUndefined();
    expect(resolveMessageAuthor({ author: "Ana", authorPeerId: "unknown" }, profiles).avatar).toBeUndefined();
  });
});
