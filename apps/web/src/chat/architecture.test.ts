import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("arquitetura do chat", () => {
  it("mantém chat.ts como fachada e as responsabilidades em módulos", async () => {
    const facade = await readFile(fileURLToPath(new URL("../chat.ts", import.meta.url)), "utf8");
    const controller = await readFile(fileURLToPath(new URL("./ChatController.ts", import.meta.url)), "utf8");

    expect(facade).toContain('export * from "./chat/index"');
    expect(facade.split("\n").filter((line) => line.trim()).length).toBeLessThanOrEqual(3);
    expect(new TextEncoder().encode(controller).byteLength).toBeLessThan(45_000);
    expect(controller).not.toMatch(/from ".+services\/attachments|from ".+offline\/outbox-storage/);
    expect(controller).toContain("new MessageService()");
    expect(controller).toContain("new GroupChatService()");
    expect(controller).toContain("new SyncService(");
  });

  it("expõe os serviços que suportam a evolução do protocolo", async () => {
    const barrel = await readFile(fileURLToPath(new URL("./index.ts", import.meta.url)), "utf8");
    for (const moduleName of [
      "ChatController",
      "MessageProtocol",
      "MessageService",
      "OutboxService",
      "HistoryService",
      "SyncService",
      "GroupChatService",
      "AttachmentService",
    ]) {
      expect(barrel).toContain(`./${moduleName}`);
    }
  });
});
