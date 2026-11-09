export async function copyText(value: string): Promise<void> {
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  textarea.setSelectionRange(0, value.length);

  let copiedWithDom = false;
  try {
    copiedWithDom = document.execCommand("copy");
  } catch {
    copiedWithDom = false;
  } finally {
    textarea.remove();
  }
  if (copiedWithDom) return;

  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  throw new Error("Área de transferência indisponível.");
}
