import { expect, it } from "vitest";
import { mergeMessageHistory } from "./message-history";

it("preserva mensagens e edições recebidas durante o carregamento do histórico", () => {
  const original = { id: "1", author: "Ana", content: "original", createdAt: "2026-01-01" };
  const edited = { ...original, editedContent: "corrigida" };
  const received = { ...original, id: "2", content: "nova", createdAt: "2026-01-02" };
  expect(mergeMessageHistory([original], [received, edited])).toEqual([edited, received]);
});
