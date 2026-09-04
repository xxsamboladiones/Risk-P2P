import { describe, expect, it } from "vitest";
import { encodedMessageSize, exactArrayBuffer } from "./messages";

describe("RTC data messages", () => {
  it("mede bytes UTF-8 em vez de caracteres JavaScript", () => {
    expect(encodedMessageSize("áudio")).toBe(6);
  });

  it("recorta somente a janela de uma view", () => {
    const source = new Uint8Array([1, 2, 3, 4]);
    expect([...new Uint8Array(exactArrayBuffer(source.subarray(1, 3)))]).toEqual([2, 3]);
  });
});
