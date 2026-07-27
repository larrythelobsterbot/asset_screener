export const ALERT_OUTCOME_CAPABILITY_GLOBAL = "__assetScreenerAlertOutcomeCapability";
export const ALERT_OUTCOME_CAPABILITY_HEADER = "X-Asset-Screener-Outcome-Capability";

type CapabilityGlobal = typeof globalThis & Record<string, unknown>;

export function isAuthorizedAlertOutcomeRequest(request: Request): boolean {
  const expected = (globalThis as CapabilityGlobal)[ALERT_OUTCOME_CAPABILITY_GLOBAL];
  const supplied = request.headers.get(ALERT_OUTCOME_CAPABILITY_HEADER);
  return typeof expected === "string" && expected !== "" && supplied === expected;
}