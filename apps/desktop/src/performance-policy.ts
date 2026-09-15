export type DesktopPerformancePolicy = {
  chromiumBackgroundThrottlingAllowed: boolean;
};

export function parseDesktopPerformancePolicy(value: unknown): DesktopPerformancePolicy {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error("Política de desempenho inválida.");
  }
  const keys = Reflect.ownKeys(value);
  const descriptor = Object.getOwnPropertyDescriptor(value, "chromiumBackgroundThrottlingAllowed");
  if (
    keys.length !== 1
    || keys[0] !== "chromiumBackgroundThrottlingAllowed"
    || !descriptor
    || !("value" in descriptor)
    || typeof descriptor.value !== "boolean"
  ) {
    throw new Error("Política de desempenho inválida.");
  }
  return { chromiumBackgroundThrottlingAllowed: descriptor.value };
}
