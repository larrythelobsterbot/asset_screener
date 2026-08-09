import { createHash } from "node:crypto";

export const HYPERLIQUID_INFO_URL = "https://api.hyperliquid.xyz/info";

export const FUNDING_POLICY_V1 = Object.freeze({
  version: "smart-money-user-funding-v1-shadow",
  responseCap: 500,
  lookbackMs: 24 * 3_600_000,
  baseWindowMs: 6 * 3_600_000,
  requestSpacingMs: 2_500,
  maxRequestsPerWallet: 128,
});

export interface RawUserFundingSource {
  rawText: string;
  byteLength: number;
  sha256: string;
}

export interface UserFundingPayment {
  address: string;
  time: number;
  coin: string;
  usdc: number;
  szi: number;
  fundingRate: number;
  nSamples: number | null;
  hash: string;
}

export interface UserFundingWindowEvidence {
  startTime: number;
  endTime: number;
  status: "complete" | "saturated";
  responseCount: number;
  sourceSha256: string;
  sourceBytes: number;
  sourceArchivePath: string;
}

export interface UserFundingRangeResult {
  address: string;
  startTime: number;
  endTime: number;
  payments: UserFundingPayment[];
  windows: UserFundingWindowEvidence[];
}

export type UserFundingWindowFetcher = (
  address: string,
  startTime: number,
  endTime: number,
) => Promise<RawUserFundingSource>;

export class UserFundingFetchError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "UserFundingFetchError";
  }
}

export function isRetryableUserFundingFetchError(error: unknown): boolean {
  return error instanceof UserFundingFetchError && error.retryable;
}

const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;
const HASH_PATTERN = /^0x[0-9a-f]{64}$/i;
const COIN_PATTERN = /^[A-Za-z0-9._-]+(?::[A-Za-z0-9._-]+)?$/;
const DECIMAL_PATTERN = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function finiteString(value: unknown, label: string): number {
  if (typeof value !== "string" || !DECIMAL_PATTERN.test(value)) {
    throw new Error(`${label} must be a numeric string`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be finite`);
  return parsed;
}

function normalizeAddress(address: string): string {
  const normalized = address.toLowerCase();
  if (!ADDRESS_PATTERN.test(normalized)) throw new Error("userFunding address is invalid");
  return normalized;
}

function normalizeCoin(value: unknown): string {
  if (typeof value !== "string" || !COIN_PATTERN.test(value) || value.length > 128) {
    throw new Error("userFunding coin is invalid");
  }
  return value.includes(":") ? value : value.toUpperCase();
}

export function parseUserFundingResponse(input: {
  address: string;
  startTime: number;
  endTime: number;
  rawText: string;
}): UserFundingPayment[] {
  const address = normalizeAddress(input.address);
  if (!Number.isInteger(input.startTime) || !Number.isInteger(input.endTime)
    || input.startTime < 0 || input.endTime < input.startTime) {
    throw new Error("userFunding request window is invalid");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(input.rawText);
  } catch {
    throw new Error("userFunding response is not valid JSON");
  }
  if (!Array.isArray(decoded)) throw new Error("userFunding response must be an array");
  return decoded.map((value, index) => {
    const row = asRecord(value, `userFunding[${index}]`);
    const delta = asRecord(row.delta, `userFunding[${index}].delta`);
    if (delta.type !== "funding") throw new Error(`userFunding[${index}] is not funding`);
    if (!Number.isInteger(row.time)) throw new Error(`userFunding[${index}].time must be an integer`);
    const time = row.time as number;
    if (time < input.startTime || time > input.endTime) {
      throw new Error(`userFunding[${index}] is outside requested window`);
    }
    if (typeof row.hash !== "string" || !HASH_PATTERN.test(row.hash)) {
      throw new Error(`userFunding[${index}].hash is invalid`);
    }
    let nSamples: number | null = null;
    if (delta.nSamples !== null && delta.nSamples !== undefined) {
      if (!Number.isInteger(delta.nSamples) || (delta.nSamples as number) < 0) {
        throw new Error(`userFunding[${index}].nSamples is invalid`);
      }
      nSamples = delta.nSamples as number;
    }
    return {
      address,
      time,
      coin: normalizeCoin(delta.coin),
      usdc: finiteString(delta.usdc, `userFunding[${index}].usdc`),
      szi: finiteString(delta.szi, `userFunding[${index}].szi`),
      fundingRate: finiteString(delta.fundingRate, `userFunding[${index}].fundingRate`),
      nSamples,
      hash: row.hash.toLowerCase(),
    };
  });
}

export function fundingPaymentKey(payment: Pick<UserFundingPayment, "address" | "time" | "coin">): string {
  return `${normalizeAddress(payment.address)}:${payment.time}:${payment.coin}`;
}

export function fundingBaseWindows(
  startTime: number,
  endTime: number,
  baseWindowMs = FUNDING_POLICY_V1.baseWindowMs,
): Array<{ startTime: number; endTime: number }> {
  if (!Number.isInteger(startTime) || !Number.isInteger(endTime)
    || startTime < 0 || endTime < startTime) {
    throw new Error("funding range is invalid");
  }
  if (!Number.isInteger(baseWindowMs) || baseWindowMs < 1) {
    throw new Error("funding base window must be a positive integer");
  }
  if (startTime === endTime) return [{ startTime, endTime }];
  const windows: Array<{ startTime: number; endTime: number }> = [];
  let cursor = startTime;
  while (cursor < endTime) {
    const windowEnd = Math.min(endTime, cursor + baseWindowMs);
    windows.push({ startTime: cursor, endTime: windowEnd });
    cursor = windowEnd;
  }
  return windows;
}

function samePayment(left: UserFundingPayment, right: UserFundingPayment): boolean {
  return left.address === right.address
    && left.time === right.time
    && left.coin === right.coin
    && left.usdc === right.usdc
    && left.szi === right.szi
    && left.fundingRate === right.fundingRate
    && left.nSamples === right.nSamples
    && left.hash === right.hash;
}

export async function collectUserFundingRange(input: {
  address: string;
  startTime: number;
  endTime: number;
  baseWindowMs?: number;
  fetchWindow: UserFundingWindowFetcher;
  archiveSource: (
    source: RawUserFundingSource,
    startTime: number,
    endTime: number,
    address: string,
  ) => string;
  maxRequests?: number;
}): Promise<UserFundingRangeResult> {
  const address = normalizeAddress(input.address);
  const baseWindows = fundingBaseWindows(input.startTime, input.endTime, input.baseWindowMs);
  const windows: UserFundingWindowEvidence[] = [];
  const payments = new Map<string, UserFundingPayment>();
  const maxRequests = input.maxRequests ?? FUNDING_POLICY_V1.maxRequestsPerWallet;
  let requestCount = 0;

  const merge = (payment: UserFundingPayment): void => {
    const key = fundingPaymentKey(payment);
    const existing = payments.get(key);
    if (existing && !samePayment(existing, payment)) {
      throw new Error(`conflicting duplicate funding payment ${key}`);
    }
    if (!existing) payments.set(key, payment);
  };

  const collectWindow = async (startTime: number, endTime: number): Promise<void> => {
    requestCount += 1;
    if (requestCount > maxRequests) throw new Error("userFunding request bound exceeded");
    const source = await input.fetchWindow(address, startTime, endTime);
    const sourceArchivePath = input.archiveSource(source, startTime, endTime, address);
    const rows = parseUserFundingResponse({ address, startTime, endTime, rawText: source.rawText });
    if (rows.length > FUNDING_POLICY_V1.responseCap) {
      throw new Error(`userFunding response exceeded cap: ${rows.length}`);
    }
    const saturated = rows.length === FUNDING_POLICY_V1.responseCap;
    windows.push({
      startTime,
      endTime,
      status: saturated ? "saturated" : "complete",
      responseCount: rows.length,
      sourceSha256: source.sha256,
      sourceBytes: source.byteLength,
      sourceArchivePath,
    });
    if (!saturated) {
      for (const payment of rows) merge(payment);
      return;
    }
    if (endTime - startTime <= 1) {
      throw new Error(`userFunding unresolved saturation at ${startTime}-${endTime}`);
    }
    const midpoint = Math.floor((startTime + endTime) / 2);
    await collectWindow(startTime, midpoint);
    await collectWindow(midpoint, endTime);
  };

  for (const window of baseWindows) {
    await collectWindow(window.startTime, window.endTime);
  }

  return {
    address,
    startTime: input.startTime,
    endTime: input.endTime,
    payments: [...payments.values()].sort((a, b) =>
      a.time - b.time || a.coin.localeCompare(b.coin) || a.address.localeCompare(b.address)),
    windows,
  };
}

export async function fetchUserFundingSource(
  address: string,
  startTime: number,
  endTime: number,
): Promise<RawUserFundingSource> {
  const user = normalizeAddress(address);
  try {
    const response = await fetch(HYPERLIQUID_INFO_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "userFunding", user, startTime, endTime }),
      signal: AbortSignal.timeout(30_000),
    });
    const rawText = await response.text();
    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500;
      throw new UserFundingFetchError(
        `Hyperliquid userFunding HTTP ${response.status}`,
        retryable,
        response.status,
      );
    }
    return {
      rawText,
      byteLength: Buffer.byteLength(rawText),
      sha256: createHash("sha256").update(rawText).digest("hex"),
    };
  } catch (error) {
    if (error instanceof UserFundingFetchError) throw error;
    const name = error instanceof Error ? error.name : "unknown";
    const retryable = error instanceof TypeError || name === "AbortError" || name === "TimeoutError";
    throw new UserFundingFetchError(
      `Hyperliquid userFunding transport failure: ${error instanceof Error ? error.message : String(error)}`,
      retryable,
    );
  }
}
