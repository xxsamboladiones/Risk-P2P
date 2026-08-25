import { describe, expect, it } from "vitest";
import { enqueueOutbox, loadOutbox, markOutboxAttempt, removeOutbox } from "./outbox-storage";

describe("caixa de saída P2P", () => {
  it("mantém mensagens por canal, registra tentativas e remove após ACK", async () => {
    const channelId = crypto.randomUUID();
    const messageId = crypto.randomUUID();
    await enqueueOutbox(channelId, messageId, "{\"type\":\"chat.message\"}");

    const [record] = await loadOutbox(channelId);
    expect(record).toEqual(expect.objectContaining({ channelId, messageId, attempts: 0 }));

    await markOutboxAttempt(record!);
    expect((await loadOutbox(channelId))[0]?.attempts).toBe(1);

    await removeOutbox(channelId, messageId);
    expect(await loadOutbox(channelId)).toEqual([]);
  });
});
