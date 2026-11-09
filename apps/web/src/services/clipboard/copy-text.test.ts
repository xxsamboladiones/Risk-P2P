import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText } from "./copy-text";

function installClipboardDom(execCommand: () => boolean) {
  const textarea = {
    value: "",
    style: {} as CSSStyleDeclaration,
    setAttribute: vi.fn(),
    select: vi.fn(),
    setSelectionRange: vi.fn(),
    remove: vi.fn(),
  };
  const appendChild = vi.fn();
  vi.stubGlobal("document", {
    createElement: vi.fn(() => textarea),
    body: { appendChild },
    execCommand: vi.fn(execCommand),
  });
  return { textarea, appendChild };
}

afterEach(() => vi.unstubAllGlobals());

describe("copyText", () => {
  it("usa a cópia DOM quando a permissão moderna do Electron não está disponível", async () => {
    const dom = installClipboardDom(() => true);
    vi.stubGlobal("navigator", {});

    await expect(copyText("diagnóstico")).resolves.toBeUndefined();

    expect(dom.textarea.value).toBe("diagnóstico");
    expect(dom.textarea.select).toHaveBeenCalledOnce();
    expect(dom.textarea.remove).toHaveBeenCalledOnce();
  });

  it("usa navigator.clipboard quando o caminho DOM não consegue copiar", async () => {
    installClipboardDom(() => false);
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    await copyText("relatório");

    expect(writeText).toHaveBeenCalledWith("relatório");
  });
});
