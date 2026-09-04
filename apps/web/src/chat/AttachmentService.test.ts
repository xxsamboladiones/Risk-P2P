import { beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  resolveStorage: undefined as undefined | ((storage: object) => void),
  constructed: 0,
}));

vi.mock("../services/attachments/desktop-storage", () => ({
  createAttachmentStorage: () => new Promise((resolve) => { runtime.resolveStorage = resolve; }),
}));

vi.mock("../services/attachments/attachment-service", () => ({
  AttachmentService: class extends EventTarget {
    constructor() { super(); runtime.constructed += 1; }
  },
}));

import { ChatAttachmentService } from "./AttachmentService";

describe("ChatAttachmentService", () => {
  beforeEach(() => {
    runtime.resolveStorage = undefined;
    runtime.constructed = 0;
  });

  it("não instala anexos de uma sessão que ficou obsoleta durante a abertura do storage", async () => {
    const service = new ChatAttachmentService();
    let current = true;
    const connecting = service.connect(
      {} as never,
      "channel_12345678",
      "peer_local_12345678",
      () => [],
      () => current,
    );
    await vi.waitFor(() => expect(runtime.resolveStorage).toBeTypeOf("function"));
    current = false;
    runtime.resolveStorage!({});

    await expect(connecting).resolves.toBeUndefined();
    expect(service.isConnected()).toBe(false);
    expect(runtime.constructed).toBe(0);
  });
});
