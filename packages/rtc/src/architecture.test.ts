import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("API pública do RTC", () => {
  it("mantém index.ts como barrel e a implementação nos módulos", async () => {
    const source = await readFile(fileURLToPath(new URL("./index.ts", import.meta.url)), "utf8");
    const statements = source.split("\n").map((line) => line.trim()).filter(Boolean);
    expect(statements.length).toBeGreaterThan(5);
    expect(statements.every((line) => line.startsWith("export * from "))).toBe(true);
    expect(source).toContain('"./transport/mesh"');
    expect(source).toContain('"./media/audio"');
    expect(source).toContain('"./diagnostics/stats"');
  });
});
