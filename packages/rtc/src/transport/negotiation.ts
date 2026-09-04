export function isMLineOrderMismatch(error: unknown): boolean {
  if (!(error instanceof DOMException) || error.name !== "InvalidAccessError") return false;
  const message = error.message.toLocaleLowerCase();
  return message.includes("order of m-lines") && message.includes("previous offer/answer");
}
