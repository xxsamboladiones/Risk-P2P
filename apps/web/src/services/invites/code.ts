export type InviteType = "friend" | "group";

const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const CODE_PATTERN = /^risk-(?:[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}-){3}[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/;

export function generateRiskInviteCode(): string {
  const values = new Uint8Array(16);
  crypto.getRandomValues(values);
  const body = [...values].map((value) => ALPHABET[value % ALPHABET.length]).join("");
  return `risk-${body.match(/.{4}/g)!.join("-")}`;
}

export function normalizeRiskInviteCode(input: string): string {
  let value = input.trim();
  const deepLink = value.match(/^risk:\/\/(?:invite|friend|group)\/(.+)$/i);
  if (deepLink) value = deepLink[1]!;
  value = value.toUpperCase().replace(/\s+/g, "").replace(/^RISK-?/, "").replace(/-/g, "");
  if (value.length > 16) value = value.slice(0, 16);
  const groups = value.match(/.{1,4}/g)?.join("-") ?? "";
  return `risk-${groups}`;
}

export function validateRiskInviteCode(input: string): boolean {
  return CODE_PATTERN.test(normalizeRiskInviteCode(input));
}

export async function deriveInviteRendezvousId(type: InviteType, input: string): Promise<string> {
  const code = normalizeRiskInviteCode(input);
  if (!validateRiskInviteCode(code)) throw new Error("Código de convite inválido.");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`risk:${type}:${code}`));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export class InviteAttemptLimiter {
  private attempts: number[] = [];
  constructor(private readonly maximum = 8, private readonly windowMs = 60_000) {}
  consume(now = Date.now()): boolean {
    this.attempts = this.attempts.filter((timestamp) => now - timestamp < this.windowMs);
    if (this.attempts.length >= this.maximum) return false;
    this.attempts.push(now);
    return true;
  }
}
