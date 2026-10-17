import { acceptHealthSample, parseHealthResponse, type HealthReceipt } from "@/lib/healthDisplay";

export interface HealthPollState { receipt: HealthReceipt | null; error: string | null; }
export const initialHealthPollState: HealthPollState = { receipt: null, error: null };

export function recordHealthSuccess(state: HealthPollState, value: unknown, receivedAt: number, receivedWallAt?: number): HealthPollState {
  const parsed = parseHealthResponse(value);
  if (!parsed) return { ...state, error: "Invalid health response" };
  const accepted = acceptHealthSample(state.receipt, parsed, receivedAt, receivedWallAt);
  return accepted ? { receipt: accepted, error: null } : state;
}
export function recordHealthError(state: HealthPollState, error: unknown): HealthPollState {
  return { ...state, error: error instanceof Error ? error.message : String(error) };
}
