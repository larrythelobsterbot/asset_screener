import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

interface LockRecord {
  pid: number;
  acquiredAt: number;
  token: string;
}

export interface PidLockOptions {
  heartbeatMs?: number;
  isPidAlive?: (pid: number) => boolean;
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function readLock(path: string): LockRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`invalid PID lock ${path}: ${(error as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`invalid PID lock ${path}: expected object`);
  }
  const record = parsed as Partial<LockRecord>;
  if (!Number.isInteger(record.pid) || (record.pid ?? 0) <= 0) {
    throw new Error(`invalid PID lock ${path}: expected positive pid`);
  }
  return {
    pid: record.pid!,
    acquiredAt: typeof record.acquiredAt === "number" ? record.acquiredAt : 0,
    token: typeof record.token === "string" ? record.token : "legacy",
  };
}

export function acquirePidLock(path: string, options: PidLockOptions = {}): () => void {
  const heartbeatMs = options.heartbeatMs ?? 60_000;
  const isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
  mkdirSync(dirname(path), { recursive: true });

  if (existsSync(path)) {
    const owner = readLock(path);
    if (isPidAlive(owner.pid)) {
      throw new Error(`another live process (${owner.pid}) holds ${path}`);
    }
    rmSync(path, { force: true });
  }

  const record: LockRecord = {
    pid: process.pid,
    acquiredAt: Date.now(),
    token: randomUUID(),
  };
  const fd = openSync(path, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(record));
  } finally {
    closeSync(fd);
  }

  const heartbeat = setInterval(() => {
    try {
      const current = readLock(path);
      if (current.pid === record.pid && current.token === record.token) {
        const now = new Date();
        utimesSync(path, now, now);
      }
    } catch {
      // A missing/replaced lock is detected by the owner on its next operation.
    }
  }, heartbeatMs);
  heartbeat.unref();

  return () => {
    clearInterval(heartbeat);
    try {
      const current = readLock(path);
      if (current.pid === record.pid && current.token === record.token) rmSync(path, { force: true });
    } catch {
      // Do not delete a lock that cannot be proven to belong to this process.
    }
  };
}

function buffersEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && left.equals(right);
}

export function contentSha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export function verifyImmutableArtifact(path: string, content: string | Buffer): void {
  if (!existsSync(path)) throw new Error(`immutable artifact missing at ${path}`);
  const expected = Buffer.isBuffer(content) ? content : Buffer.from(content);
  if (!buffersEqual(readFileSync(path), expected)) {
    throw new Error(`immutable artifact content mismatch at ${path}`);
  }
}

export function verifyImmutableArtifactHash(path: string, expectedSha256: string): void {
  if (!existsSync(path)) throw new Error(`immutable artifact missing at ${path}`);
  const actualSha256 = contentSha256(readFileSync(path));
  if (actualSha256 !== expectedSha256) {
    throw new Error(`immutable artifact hash mismatch at ${path}`);
  }
}

export function writeImmutableArtifact(path: string, content: string | Buffer): boolean {
  const expected = Buffer.isBuffer(content) ? content : Buffer.from(content);
  mkdirSync(dirname(path), { recursive: true });
  const verifyExisting = (): false => {
    verifyImmutableArtifact(path, expected);
    return false;
  };
  if (existsSync(path)) return verifyExisting();

  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, expected, { flag: "wx", mode: 0o600 });
  try {
    try {
      linkSync(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return verifyExisting();
      throw error;
    }
    return true;
  } finally {
    unlinkSync(temporary);
  }
}

export function verifyContentAddressedSourceArchive(
  path: string,
  expectedSha256: string,
  expectedBytes: number,
): void {
  if (!path.endsWith(`/${expectedSha256}.json.gz`)) {
    throw new Error(`source archive path identity mismatch at ${path}`);
  }
  if (!existsSync(path)) throw new Error(`source archive missing at ${path}`);
  try {
    const raw = gunzipSync(readFileSync(path));
    if (raw.byteLength !== expectedBytes) {
      throw new Error(`byte length ${raw.byteLength} != ${expectedBytes}`);
    }
    const actualSha256 = createHash("sha256").update(raw).digest("hex");
    if (actualSha256 !== expectedSha256) {
      throw new Error(`hash ${actualSha256} != ${expectedSha256}`);
    }
  } catch (error) {
    throw new Error(`source archive verification failed at ${path}: ${String(error)}`);
  }
}

export function writeContentAddressedSourceArchive(
  root: string,
  source: string,
  sha256: string,
  rawText: string,
): string {
  const actualHash = createHash("sha256").update(rawText).digest("hex");
  if (actualHash !== sha256) throw new Error(`${source} source hash mismatch: ${sha256} != ${actualHash}`);
  const path = join(root, "sources", source, `${sha256}.json.gz`);
  if (existsSync(path)) {
    verifyContentAddressedSourceArchive(path, sha256, Buffer.byteLength(rawText));
    return path;
  }
  writeImmutableArtifact(path, gzipSync(rawText, { level: 9 }));
  verifyContentAddressedSourceArchive(path, sha256, Buffer.byteLength(rawText));
  return path;
}

export function ensureBeforeDeadline(deadlineAt: number, now: number, label: string): void {
  if (now > deadlineAt) throw new Error(`${label} deadline exceeded at ${new Date(now).toISOString()}`);
}

export function ensureNoCohortRetrievalFailures(errors: Array<string | null>): void {
  const allowed = "portfolio_history_insufficient_for_90d_evidence";
  const failures = errors.filter((error): error is string => error !== null && error !== allowed);
  if (failures.length > 0) {
    throw new Error(`cohort candidate retrieval failures (${failures.length}); preserving previous cohort`);
  }
}

export function digestArtifactIdentity(
  root: string,
  periodDate: string,
  collectionRunId: number,
  kind: "daily" | "baseline",
): { key: string; markdownPath: string; chartPath: string } {
  const directory = join(root, periodDate);
  return kind === "baseline"
    ? {
      key: `smart-money-baseline:${collectionRunId}`,
      markdownPath: join(directory, `baseline-${collectionRunId}.md`),
      chartPath: join(directory, `baseline-positioning-${collectionRunId}.svg`),
    }
    : {
      key: `smart-money-daily:${periodDate}`,
      markdownPath: join(directory, "daily.md"),
      chartPath: join(directory, "cohort-positioning.svg"),
    };
}

export function collectionRunKey(
  scheduledFor: number,
  cohortVersionId: number,
  eventPolicyVersion: string,
): string {
  const bucket = new Date(scheduledFor).toISOString().slice(0, 13);
  return `smart-money-collection:${bucket}:cohort-${cohortVersionId}:event-policy-${eventPolicyVersion}`;
}

export function cohortEvidenceRunKey(weekStart: number, cohortVersionId: number): string {
  const week = new Date(weekStart).toISOString().slice(0, 10);
  return `smart-money-cohort-evidence:${week}:cohort-${cohortVersionId}`;
}
