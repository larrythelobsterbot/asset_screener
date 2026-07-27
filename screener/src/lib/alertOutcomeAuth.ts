import { timingSafeEqual } from "node:crypto";

export const ALERT_OUTCOME_CAPABILITY_GLOBAL = "__assetScreenerAlertOutcomeCapability";
export const ALERT_OUTCOME_CAPABILITY_HEADER = "X-Asset-Screener-Outcome-Capability";

type CapabilityGlobal = typeof globalThis & Record<string, unknown>;

export function isAuthorizedAlertOutcomeRequest(request: Request): boolean {
  const expected = (globalThis as CapabilityGlobal)[ALERT_OUTCOME_CAPABILITY_GLOBAL];
  const supplied = request.headers.get(ALERT_OUTCOME_CAPABILITY_HEADER);
  if (typeof expected !== "string" || expected === "" || supplied === null) return false;
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  return expectedBytes.length === suppliedBytes.length
    && timingSafeEqual(expectedBytes, suppliedBytes);
}
