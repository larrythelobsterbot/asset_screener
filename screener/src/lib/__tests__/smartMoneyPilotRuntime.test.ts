import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  acquirePidLock,
  collectionRunKey,
  cohortEvidenceRunKey,
  digestArtifactIdentity,
  ensureBeforeDeadline,
  ensureNoCohortRetrievalFailures,
  verifyImmutableArtifact,
  verifyImmutableArtifactHash,
  writeContentAddressedSourceArchive,
  writeImmutableArtifact,
} from "../smartMoneyPilotRuntime";

function temporaryDirectory(): string {
  return mkdtempSync(join(tmpdir(), "smart-money-runtime-"));
}

test("PID lock never evicts a live owner based only on age", () => {
  const directory = temporaryDirectory();
  try {
    const path = join(directory, "pilot.lock");
    writeFileSync(path, JSON.stringify({ pid: process.pid, acquiredAt: 1 }));
    const old = new Date(0);
    utimesSync(path, old, old);
    assert.throws(() => acquirePidLock(path, {
      heartbeatMs: 60_000,
      isPidAlive: (pid) => pid === process.pid,
    }), /live process/);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).pid, process.pid);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("PID lock recovers a dead owner and releases only its own lease", () => {
  const directory = temporaryDirectory();
  try {
    const path = join(directory, "pilot.lock");
    writeFileSync(path, JSON.stringify({ pid: 999_999, acquiredAt: 1 }));
    const release = acquirePidLock(path, {
      heartbeatMs: 60_000,
      isPidAlive: () => false,
    });
    assert.equal(JSON.parse(readFileSync(path, "utf8")).pid, process.pid);
    release();
    assert.throws(() => readFileSync(path), /ENOENT/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("immutable artifacts reject stale content and source archives verify their hash", () => {
  const directory = temporaryDirectory();
  try {
    const artifact = join(directory, "daily.md");
    assert.equal(writeImmutableArtifact(artifact, "first"), true);
    assert.equal(writeImmutableArtifact(artifact, "first"), false);
    assert.doesNotThrow(() => verifyImmutableArtifact(artifact, "first"));
    assert.doesNotThrow(() => verifyImmutableArtifactHash(
      artifact,
      createHash("sha256").update("first").digest("hex"),
    ));
    assert.throws(() => writeImmutableArtifact(artifact, "different"), /content mismatch/);
    writeFileSync(artifact, "corrupted");
    assert.throws(() => verifyImmutableArtifact(artifact, "first"), /content mismatch/);
    assert.throws(() => verifyImmutableArtifactHash(artifact, "0".repeat(64)), /hash mismatch/);
    rmSync(artifact);
    assert.throws(() => verifyImmutableArtifact(artifact, "first"), /missing/);

    const raw = JSON.stringify({ rows: [1, 2, 3] });
    const sha256 = createHash("sha256").update(raw).digest("hex");
    const archived = writeContentAddressedSourceArchive(directory, "vaults", sha256, raw);
    assert.match(archived, new RegExp(`${sha256}\\.json\\.gz$`));
    assert.equal(writeContentAddressedSourceArchive(directory, "vaults", sha256, raw), archived);
    assert.throws(
      () => writeContentAddressedSourceArchive(directory, "vaults", "0".repeat(64), raw),
      /hash mismatch/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("cohort work fails closed after its overall deadline", () => {
  assert.doesNotThrow(() => ensureBeforeDeadline(1_000, 999, "cohort"));
  assert.throws(() => ensureBeforeDeadline(1_000, 1_001, "cohort"), /cohort deadline exceeded/);
});

test("weekly cohort publication fails closed on candidate retrieval errors", () => {
  assert.doesNotThrow(() => ensureNoCohortRetrievalFailures([
    null,
    "portfolio_history_insufficient_for_90d_evidence",
  ]));
  assert.throws(() => ensureNoCohortRetrievalFailures([null, "HTTP 503"]), /retrieval failures/);
});

test("bootstrap baseline cannot consume the complete daily digest identity", () => {
  const baseline = digestArtifactIdentity("/tmp/drafts", "2026-07-31", 42, "baseline");
  const nextBaseline = digestArtifactIdentity("/tmp/drafts", "2026-07-31", 43, "baseline");
  const daily = digestArtifactIdentity("/tmp/drafts", "2026-07-31", 42, "daily");
  assert.notEqual(baseline.key, daily.key);
  assert.notEqual(baseline.markdownPath, nextBaseline.markdownPath);
  assert.notEqual(baseline.chartPath, nextBaseline.chartPath);
  assert.match(baseline.key, /^smart-money-baseline:42$/);
  assert.match(baseline.markdownPath, /baseline-42\.md$/);
  assert.match(baseline.chartPath, /baseline-positioning-42\.svg$/);
  assert.match(daily.key, /^smart-money-daily:2026-07-31$/);
  assert.match(daily.markdownPath, /daily\.md$/);
});

test("collection idempotency is scoped to the cohort and detector policy versions", () => {
  const scheduledFor = Date.UTC(2026, 6, 31, 12);
  const v2 = "smart-money-pilot-events-v2-shadow";
  const v3 = "smart-money-trade-change-v3-shadow";
  assert.notEqual(collectionRunKey(scheduledFor, 1, v3), collectionRunKey(scheduledFor, 2, v3));
  assert.notEqual(collectionRunKey(scheduledFor, 2, v2), collectionRunKey(scheduledFor, 2, v3));
  assert.equal(
    collectionRunKey(scheduledFor, 2, v3),
    "smart-money-collection:2026-07-31T12:cohort-2:event-policy-smart-money-trade-change-v3-shadow",
  );
  assert.notEqual(cohortEvidenceRunKey(scheduledFor, 1), cohortEvidenceRunKey(scheduledFor, 2));
});
