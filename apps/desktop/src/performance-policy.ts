export type DesktopPerformancePolicy = {
  chromiumBackgroundThrottlingAllowed: boolean;
};

export function parseDesktopPerformancePolicy(value: unknown): DesktopPerformancePolicy {
  if (
    !value
    || typeof value !== "object"
    || Object.keys(value).length !== 1
    || typeof (value as DesktopPerformancePolicy).chromiumBackgroundThrottlingAllowed !== "boolean"
  ) {
    throw new Error("Política de desempenho inválida.");
  }
  return value as DesktopPerformancePolicy;
}
