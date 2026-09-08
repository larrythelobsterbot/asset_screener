import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import {
  closeSync,
  createReadStream,
  createWriteStream,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { createGunzip, createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { PassThrough, Transform } from "node:stream";
import { createInterface } from "node:readline";

export const ARCHIVE_FORMAT = "research-archive-v1" as const;
export const ROLLUP_MS = 5 * 60 * 1_000;
export const MAX_RANGE_MS = 31 * 24 * 60 * 60 * 1_000;
const FILES = ["snapshots.jsonl.gz", "candles.jsonl.gz", "oi-events.jsonl.gz", "oi-outcomes.jsonl.gz"] as const;
type DatasetName = "snapshots" | "candles" | "oiEvents" | "oiOutcomes";
const DATASETS: readonly DatasetName[] = ["snapshots", "candles", "oiEvents", "oiOutcomes"];
const SCHEMA_DESCRIPTIONS: Record<DatasetName, string> = {
  snapshots: "snapshot rollup",
  candles: "candle record",
  oiEvents: "OI surge event with complete initial/latest JSON evidence",
  oiOutcomes: "OI surge outcome",
};

export interface ArchiveOptions {
  source: string;
  out: string;
  from: string;
  to: string;
  /** Test hook; production callers should omit it. */
  now?: number;
}

interface SourceExtent { min: number | null; max: number | null; count: number; }
interface DatasetManifest { file: string; count: number; range: { min: number | null; max: number | null }; }
interface FileManifest { path: string; sha256: string; bytes: number; count: number; }
interface SnapshotRow { symbol: string; ts: number; mark: number; prev_day: number | null; funding: number | null; oi: number | null; volume: number | null; }

export interface ArchiveManifest {
  format: typeof ARCHIVE_FORMAT;
  createdAt: string;
  source: {
    path: string;
    schemaVersion: number;
    observationExtent: Record<string, SourceExtent>;
    observationExtentScope: "selected-range-only";
  };
  range: { from: string; to: string; fromMs: number; toMs: number; semantics: "[from,to)" };
  provenance: {
    historicalIdentity: "legacy-symbol";
    venueMetadataAvailable: false;
    volume: "rolling24hVolume_latest_not_summed";
    rollup: "five-minute-snapshot-rollups_not_raw_snapshots";
  };
  schema: { rollupMs: number; datasets: Record<DatasetName, string> };
  datasets: Record<DatasetName, DatasetManifest>;
  files: FileManifest[];
}

const EVENT_COLUMNS = [
  "id", "policy_version", "source", "mode", "symbol", "sector", "started_at", "last_detected_at",
  "severity", "primary_horizon", "entry_mark", "entry_oi_usd", "latest_quadrant",
  "max_oi_coins_change_pct", "max_quantity_delta_usd", "latest_price_change_pct", "volume_24h",
  "funding_hourly", "horizons_json", "lanes_json", "initial_evidence_json", "latest_evidence_json",
  "created_at", "updated_at", "pilot_eligible_at",
] as const;
const OUTCOME_COLUMNS = [
  "event_id", "horizon", "target_at", "status", "snapshot_at", "mark", "return_pct",
  "abs_return_pct", "high_return_pct", "low_return_pct", "observed_at", "note",
] as const;
const SNAPSHOT_KEYS = [
  "symbol", "bucket_start", "bucket_end", "first", "last", "mark_min", "mark_max", "oi_min", "oi_max",
  "snapshot_count", "coverage", "funding_sample_sum", "funding_sample_count", "rolling24h_volume_latest",
] as const;
const SNAPSHOT_ROW_KEYS = ["symbol", "ts", "mark", "prev_day", "funding", "oi", "volume"] as const;
const CANDLE_KEYS = ["symbol", "interval", "t", "o", "h", "l", "c", "v"] as const;
const COVERAGE_KEYS = ["first_ts", "last_ts", "observed_points", "duration_ms"] as const;
const EVENT_JSON_KEYS = ["horizons_json", "lanes_json", "initial_evidence_json", "latest_evidence_json"] as const;
const OUTCOME_STATUS = new Set(["observed", "missing", "untrackable"]);
const OUTCOME_HORIZONS = new Set(["1h", "4h", "24h"]);

function fail(message: string): never { throw new Error(`research archive: ${message}`); }
function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`${label} is not finite`);
  return value;
}
function integer(value: unknown, label: string): number {
  const result = finite(value, label);
  if (!Number.isSafeInteger(result)) fail(`${label} is not an integer`);
  return result;
}
function nullableFinite(value: unknown, label: string): number | null {
  if (value === null || value === undefined) return null;
  return finite(value, label);
}
function nullableInteger(value: unknown, label: string): number | null {
  if (value === null || value === undefined) return null;
  return integer(value, label);
}
function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) fail(`${label} must be a non-empty string`);
  return value;
}
function assertKeys(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  const record = value as Record<string, unknown>;
  const expected = new Set(keys);
  for (const key of keys) if (!Object.prototype.hasOwnProperty.call(record, key)) fail(`${label} is missing ${key}`);
  for (const key of Object.keys(record)) if (!expected.has(key)) fail(`${label} contains unknown field ${key}`);
  return record;
}
function canonicalIso(value: unknown, label: string): number {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) fail(`${label} must use canonical UTC ISO-8601 form`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) fail(`${label} is invalid`);
  return parsed;
}
function parseInputIso(value: string, label: string): number {
  if (typeof value !== "string" || !/[Tt].*(?:[Zz]|[+-]\d{2}:?\d{2})$/.test(value)) fail(`${label} must be an ISO timestamp with timezone`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) fail(`${label} is invalid`);
  return parsed;
}
function validateRange(fromText: string, toText: string, now = Date.now()): { from: number; to: number; fromIso: string; toIso: string } {
  const from = parseInputIso(fromText, "from");
  const to = parseInputIso(toText, "to");
  if (!Number.isFinite(now)) fail("now is not finite");
  if (from >= to) fail("from must be before to");
  if (to - from > MAX_RANGE_MS) fail("range exceeds the 31-day bounded export limit");
  if (to > now) fail("to cannot be in the future");
  return { from, to, fromIso: new Date(from).toISOString(), toIso: new Date(to).toISOString() };
}
function canonical(value: unknown): string { return JSON.stringify(value) + "\n"; }
function inside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Reject symlink aliases in every existing component, including dangling links. */
function rejectSymlinkComponents(path: string, label: string): string {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let current = root;
  const rest = absolute.slice(root.length).split(sep).filter(Boolean);
  for (const part of rest) {
    current = join(current, part);
    let stat;
    try { stat = lstatSync(current); } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") break;
      fail(`${label} cannot be inspected: ${String(error)}`);
    }
    if (stat.isSymbolicLink()) fail(`${label} contains a symlink component`);
  }
  return absolute;
}
function requireRegularFile(path: string, label: string): string {
  const absolute = rejectSymlinkComponents(path, label);
  let stat;
  try { stat = lstatSync(absolute); } catch { fail(`${label} does not exist`); }
  if (!stat!.isFile() || stat!.isSymbolicLink()) fail(`${label} must be a regular file`);
  return absolute;
}
function requireRealDirectory(path: string, label: string): string {
  const absolute = rejectSymlinkComponents(path, label);
  let stat;
  try { stat = lstatSync(absolute); } catch { fail(`${label} does not exist`); }
  if (!stat!.isDirectory() || stat!.isSymbolicLink()) fail(`${label} must be a real directory`);
  return absolute;
}
function rejectOverlappingOutput(source: string, output: string): void {
  const sourcePath = resolve(source);
  const outputPath = resolve(output);
  if (sourcePath === outputPath || inside(outputPath, sourcePath)) fail("output overlaps the source database");
  // The lexical checks above cover the source file itself and an output
  // directory that would contain it. Physical source resolution is still
  // required before opening the source, but a sibling output shares its
  // parent directory and is not an overlap.
  realpathSync(sourcePath);
}
function tableExists(db: Database.Database, name: string): boolean {
  const row = db.prepare("select 1 as present from sqlite_master where type = 'table' and name = ?").get(name) as { present?: number } | undefined;
  return row?.present === 1;
}
function columnsOf(db: Database.Database, table: string): Set<string> {
  return new Set((db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((column) => column.name));
}
function writeLines(path: string, writer: (write: (value: unknown) => void) => void): number {
  const fd = openSync(path, "wx");
  let count = 0;
  try {
    writer((value) => {
      const bytes = Buffer.from(canonical(value));
      for (let offset = 0; offset < bytes.length;) offset += writeSync(fd, bytes, offset, bytes.length - offset);
      count += 1;
    });
  } finally { closeSync(fd); }
  return count;
}
function writeExclusiveFile(path: string, value: Buffer): { dev: number; ino: number } {
  const fd = openSync(path, "wx");
  const owned = fstatSync(fd);
  try {
    for (let offset = 0; offset < value.length;) offset += writeSync(fd, value, offset, value.length - offset);
    closeSync(fd);
    return { dev: owned.dev, ino: owned.ino };
  } catch (error) {
    try { closeSync(fd); } catch { /* close already failed */ }
    try { const stat = lstatSync(path); if (stat.dev === owned.dev && stat.ino === owned.ino) unlinkSync(path); } catch { /* never remove an unowned path */ }
    throw error;
  }
}
function parseJsonField(value: unknown, label: string): string {
  if (typeof value !== "string") fail(`${label} is not JSON text`);
  try { JSON.parse(value); } catch { fail(`${label} contains invalid JSON`); }
  return value;
}
function validateEvidence(value: unknown, label: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be a JSON object`);
  const record = value as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(record, "mark")) nullableFinite(record.mark, `${label}.mark`);
  if (Object.prototype.hasOwnProperty.call(record, "oi")) nullableFinite(record.oi, `${label}.oi`);
}
function validateEventJson(value: string, label: string): void {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { fail(`${label} contains invalid JSON`); }
  if (label.endsWith("horizons_json") || label.endsWith("lanes_json")) {
    if (!Array.isArray(parsed)) fail(`${label} must be a JSON array`);
    for (const item of parsed as unknown[]) {
      if (typeof item === "string") text(item, `${label} item`);
      else if (item && typeof item === "object" && !Array.isArray(item)) {
        const key = label.endsWith("horizons_json") ? "horizon" : "lane";
        text((item as Record<string, unknown>)[key], `${label}.${key}`);
      } else fail(`${label} contains an invalid item`);
    }
  } else validateEvidence(parsed, label);
}
function validateSnapshotRow(value: unknown, label: string): SnapshotRow {
  const row = assertKeys(value, SNAPSHOT_ROW_KEYS, label);
  return {
    symbol: text(row.symbol, `${label}.symbol`),
    ts: integer(row.ts, `${label}.ts`),
    mark: finite(row.mark, `${label}.mark`),
    prev_day: nullableFinite(row.prev_day, `${label}.prev_day`),
    funding: nullableFinite(row.funding, `${label}.funding`),
    oi: nullableFinite(row.oi, `${label}.oi`),
    volume: nullableFinite(row.volume, `${label}.volume`),
  };
}
function validateSnapshotRecord(value: unknown, label = "snapshot"): Record<string, unknown> {
  const row = assertKeys(value, SNAPSHOT_KEYS, label);
  const first = validateSnapshotRow(row.first, `${label}.first`);
  const last = validateSnapshotRow(row.last, `${label}.last`);
  const bucketStart = integer(row.bucket_start, `${label}.bucket_start`);
  const bucketEnd = integer(row.bucket_end, `${label}.bucket_end`);
  if (bucketEnd !== bucketStart + ROLLUP_MS || bucketStart >= bucketEnd) fail(`${label} has invalid bucket bounds`);
  if (bucketStart !== Math.floor(first.ts / ROLLUP_MS) * ROLLUP_MS) fail(`${label} bucket does not align with first timestamp`);
  if (first.symbol !== row.symbol || last.symbol !== row.symbol) fail(`${label} first/last symbol mismatch`);
  if (first.ts > last.ts) fail(`${label} first timestamp is after last timestamp`);
  if (first.ts < bucketStart || last.ts >= bucketEnd) fail(`${label} first/last timestamp is outside its bucket`);
  const count = integer(row.snapshot_count, `${label}.snapshot_count`);
  if (count < 1) fail(`${label}.snapshot_count must be positive`);
  const markMin = finite(row.mark_min, `${label}.mark_min`); const markMax = finite(row.mark_max, `${label}.mark_max`);
  if (markMin > markMax || first.mark < markMin || first.mark > markMax || last.mark < markMin || last.mark > markMax) fail(`${label} mark range is invalid`);
  const oiMin = nullableFinite(row.oi_min, `${label}.oi_min`); const oiMax = nullableFinite(row.oi_max, `${label}.oi_max`);
  if ((oiMin === null) !== (oiMax === null) || (oiMin !== null && oiMin > oiMax!)) fail(`${label} OI range is invalid`);
  const endpointOis = [first.oi, last.oi].filter((value): value is number => value !== null);
  if (endpointOis.length > 0 && (oiMin === null || oiMax === null || endpointOis.some((value) => value < oiMin! || value > oiMax!))) fail(`${label} OI range does not contain non-null first/last OI`);
  const coverage = assertKeys(row.coverage, COVERAGE_KEYS, `${label}.coverage`);
  if (integer(coverage.first_ts, `${label}.coverage.first_ts`) !== first.ts || integer(coverage.last_ts, `${label}.coverage.last_ts`) !== last.ts || integer(coverage.observed_points, `${label}.coverage.observed_points`) !== count || integer(coverage.duration_ms, `${label}.coverage.duration_ms`) !== last.ts - first.ts) fail(`${label} coverage does not match first/last/count`);
  const fundingCount = integer(row.funding_sample_count, `${label}.funding_sample_count`);
  const fundingSum = finite(row.funding_sample_sum, `${label}.funding_sample_sum`);
  if (fundingCount < 0 || fundingCount > count) fail(`${label} funding sample count is invalid`);
  const knownFundingEndpoints = Number(first.funding !== null)
    + Number(count > 1 && last.funding !== null);
  if (fundingCount < knownFundingEndpoints) fail(`${label} funding sample count is below known funded endpoints`);
  if (count === 1) {
    const sameSourceRow = first.symbol === last.symbol && first.ts === last.ts && first.mark === last.mark && first.prev_day === last.prev_day && first.funding === last.funding && first.oi === last.oi && first.volume === last.volume;
    if (!sameSourceRow || fundingCount !== (first.funding === null ? 0 : 1) || fundingSum !== (first.funding ?? 0)) fail(`${label} single-snapshot source/funding fields are inconsistent`);
    if (markMin !== first.mark || markMax !== first.mark || (oiMin !== null && oiMin !== first.oi) || (oiMax !== null && oiMax !== first.oi)) fail(`${label} single-snapshot ranges are inconsistent`);
  }
  if (fundingCount === 0 && fundingSum !== 0) fail(`${label} funding sum is non-zero with no samples`);
  const rollingVolume = nullableFinite(row.rolling24h_volume_latest, `${label}.rolling24h_volume_latest`);
  if (rollingVolume !== last.volume) fail(`${label} rolling volume does not match last source value`);
  return row;
}
function validateCandleRecord(value: unknown, label = "candle"): Record<string, unknown> {
  const row = assertKeys(value, CANDLE_KEYS, label);
  text(row.symbol, `${label}.symbol`); text(row.interval, `${label}.interval`); integer(row.t, `${label}.t`);
  const o = finite(row.o, `${label}.o`); const h = finite(row.h, `${label}.h`); const l = finite(row.l, `${label}.l`); const c = finite(row.c, `${label}.c`); const v = finite(row.v, `${label}.v`);
  if (h < Math.max(o, c) || l > Math.min(o, c) || h < l) fail(`${label} has invalid OHLC bounds`);
  if (v < 0) fail(`${label}.v cannot be negative`);
  return row;
}
function validateEventRecord(value: unknown, label = "oi event"): Record<string, unknown> {
  const row = assertKeys(value, EVENT_COLUMNS, label);
  const eventId = integer(row.id, `${label}.id`); if (eventId < 1) fail(`${label}.id must be positive`); text(row.policy_version, `${label}.policy_version`); text(row.source, `${label}.source`); text(row.mode, `${label}.mode`); text(row.symbol, `${label}.symbol`); text(row.sector, `${label}.sector`);
  for (const key of ["started_at", "last_detected_at", "created_at", "updated_at"] as const) integer(row[key], `${label}.${key}`);
  if ((row.last_detected_at as number) < (row.started_at as number)) fail(`${label} last_detected_at precedes started_at`);
  for (const key of ["severity", "primary_horizon", "latest_quadrant"] as const) text(row[key], `${label}.${key}`);
  for (const key of ["entry_mark", "entry_oi_usd", "max_oi_coins_change_pct", "max_quantity_delta_usd", "latest_price_change_pct", "volume_24h"] as const) finite(row[key], `${label}.${key}`);
  nullableFinite(row.funding_hourly, `${label}.funding_hourly`); nullableInteger(row.pilot_eligible_at, `${label}.pilot_eligible_at`);
  for (const key of EVENT_JSON_KEYS) { const json = parseJsonField(row[key], `${label}.${key}`); validateEventJson(json, `${label}.${key}`); }
  return row;
}
function validateOutcomeRecord(value: unknown, label = "oi outcome"): Record<string, unknown> {
  const row = assertKeys(value, OUTCOME_COLUMNS, label);
  const eventId = integer(row.event_id, `${label}.event_id`); if (eventId < 1) fail(`${label}.event_id must be positive`);
  const horizon = text(row.horizon, `${label}.horizon`); if (!OUTCOME_HORIZONS.has(horizon)) fail(`${label}.horizon is unsupported`);
  const target = integer(row.target_at, `${label}.target_at`); const status = text(row.status, `${label}.status`); if (!OUTCOME_STATUS.has(status)) fail(`${label}.status is unsupported`);
  nullableInteger(row.snapshot_at, `${label}.snapshot_at`); nullableFinite(row.mark, `${label}.mark`); nullableFinite(row.return_pct, `${label}.return_pct`); nullableFinite(row.abs_return_pct, `${label}.abs_return_pct`); nullableFinite(row.high_return_pct, `${label}.high_return_pct`); nullableFinite(row.low_return_pct, `${label}.low_return_pct`); integer(row.observed_at, `${label}.observed_at`); if (row.note !== null && row.note !== undefined) text(row.note, `${label}.note`);
  if (status === "observed" && (row.snapshot_at === null || row.mark === null || row.return_pct === null)) fail(`${label} observed outcome is missing observed values`);
  if (status !== "observed" && (row.mark !== null || row.return_pct !== null)) fail(`${label} non-observed outcome has observed values`);
  return { ...row, event_id: eventId, target_at: target };
}

function updateRange(range: { min: number | null; max: number | null }, value: number): void {
  range.min = range.min === null ? value : Math.min(range.min, value);
  range.max = range.max === null ? value : Math.max(range.max, value);
}
function extent(): SourceExtent { return { min: null, max: null, count: 0 }; }
function observe(range: SourceExtent, value: number, amount = 1): void { updateRange(range, value); range.count += amount; }
function datasetRange(range: { min: number | null; max: number | null }): { min: number | null; max: number | null } { return { min: range.min, max: range.max }; }
function snapshotRollups(db: Database.Database, from: number, to: number, write: (value: unknown) => void, sourceExtent: SourceExtent): number {
  if (!tableExists(db, "price_snapshots")) return 0;
  const statement = db.prepare(`select symbol, ts, mark, prev_day, funding, oi, volume from price_snapshots where ts >= ? and ts < ? order by symbol asc, ts asc`);
  let current: (SnapshotRow & { bucket: number; first: SnapshotRow; last: SnapshotRow; count: number; markMin: number; markMax: number; oiMin: number | null; oiMax: number | null; fundingSum: number; fundingCount: number }) | null = null;
  let emitted = 0;
  const flush = () => {
    if (!current) return;
    const { symbol, bucket, first, last, count, markMin, markMax, oiMin, oiMax, fundingSum, fundingCount } = current;
    const value = {
      symbol, bucket_start: bucket, bucket_end: bucket + ROLLUP_MS,
      first, last, mark_min: markMin, mark_max: markMax, oi_min: oiMin, oi_max: oiMax,
      snapshot_count: count,
      coverage: { first_ts: first.ts, last_ts: last.ts, observed_points: count, duration_ms: last.ts - first.ts },
      funding_sample_sum: fundingSum, funding_sample_count: fundingCount,
      rolling24h_volume_latest: last.volume,
    };
    validateSnapshotRecord(value);
    observe(sourceExtent, first.ts, count); updateRange(sourceExtent, last.ts);
    write(value); emitted += 1;
  };
  for (const raw of statement.iterate(from, to) as Iterable<SnapshotRow>) {
    const row: SnapshotRow = { symbol: text(raw.symbol, "snapshot.symbol"), ts: integer(raw.ts, "snapshot.ts"), mark: finite(raw.mark, "snapshot.mark"), prev_day: nullableFinite(raw.prev_day, "snapshot.prev_day"), funding: nullableFinite(raw.funding, "snapshot.funding"), oi: nullableFinite(raw.oi, "snapshot.oi"), volume: nullableFinite(raw.volume, "snapshot.volume") };
    const bucket = Math.floor(row.ts / ROLLUP_MS) * ROLLUP_MS;
    if (!current || current.symbol !== row.symbol || current.bucket !== bucket) { flush(); current = { ...row, bucket, first: row, last: row, count: 1, markMin: row.mark, markMax: row.mark, oiMin: row.oi, oiMax: row.oi, fundingSum: row.funding ?? 0, fundingCount: row.funding === null ? 0 : 1 }; continue; }
    current.last = row; current.count += 1; current.markMin = Math.min(current.markMin, row.mark); current.markMax = Math.max(current.markMax, row.mark);
    if (row.oi !== null) { current.oiMin = current.oiMin === null ? row.oi : Math.min(current.oiMin, row.oi); current.oiMax = current.oiMax === null ? row.oi : Math.max(current.oiMax, row.oi); }
    if (row.funding !== null) { current.fundingSum += row.funding; current.fundingCount += 1; }
  }
  flush(); return emitted;
}
function candles(db: Database.Database, from: number, to: number, write: (value: unknown) => void, sourceExtent: SourceExtent): number {
  if (!tableExists(db, "candles_cache")) return 0;
  let count = 0;
  const statement = db.prepare("select symbol, interval, t, o, h, l, c, v from candles_cache where t >= ? and t < ? order by symbol asc, interval asc, t asc");
  for (const raw of statement.iterate(from, to) as Iterable<Record<string, unknown>>) { const value = { symbol: raw.symbol, interval: raw.interval, t: raw.t, o: raw.o, h: raw.h, l: raw.l, c: raw.c, v: raw.v }; validateCandleRecord(value); observe(sourceExtent, integer(raw.t, "candle.t")); write(value); count += 1; }
  return count;
}
function events(db: Database.Database, from: number, to: number, write: (value: unknown) => void, sourceExtent: SourceExtent): number[] {
  if (!tableExists(db, "oi_surge_events")) return [];
  const available = columnsOf(db, "oi_surge_events");
  for (const column of EVENT_COLUMNS.filter((column) => column !== "pilot_eligible_at")) if (!available.has(column)) fail(`oi_surge_events is missing ${column}`);
  const selected = EVENT_COLUMNS.filter((column) => available.has(column));
  const statement = db.prepare(`select ${selected.join(", ")} from oi_surge_events where started_at >= ? and started_at < ? order by id asc`);
  const ids: number[] = [];
  for (const raw of statement.iterate(from, to) as Iterable<Record<string, unknown>>) { const record: Record<string, unknown> = {}; for (const column of EVENT_COLUMNS) record[column] = raw[column] ?? null; validateEventRecord(record); observe(sourceExtent, record.started_at as number); write(record); ids.push(record.id as number); }
  return ids;
}
function outcomes(db: Database.Database, ids: number[], write: (value: unknown) => void, sourceExtent: SourceExtent): number {
  if (!tableExists(db, "oi_surge_outcomes") || ids.length === 0) return 0;
  const available = columnsOf(db, "oi_surge_outcomes");
  for (const column of OUTCOME_COLUMNS) if (!available.has(column)) fail(`oi_surge_outcomes is missing ${column}`);
  let count = 0;
  for (let start = 0; start < ids.length; start += 500) {
    const part = ids.slice(start, start + 500);
    const statement = db.prepare(`select ${OUTCOME_COLUMNS.join(", ")} from oi_surge_outcomes where event_id in (${part.map(() => "?").join(",")}) order by event_id asc, horizon asc`);
    for (const raw of statement.iterate(...part) as Iterable<Record<string, unknown>>) { const value = Object.fromEntries(OUTCOME_COLUMNS.map((column) => [column, raw[column] ?? null])); validateOutcomeRecord(value); observe(sourceExtent, value.target_at as number); write(value); count += 1; }
  }
  return count;
}
async function gzipFile(source: string, destination: string): Promise<void> {
  let opened = false;
  const output = createWriteStream(destination, { flags: "wx" });
  output.once("open", () => { opened = true; });
  try { await pipeline(createReadStream(source), createGzip({ level: 9 }), output); unlinkSync(source); } catch (error) {
    if (opened) { try { if (lstatSync(destination).isFile()) unlinkSync(destination); } catch { /* the owned output was already removed */ } }
    throw error;
  }
}
function sha256File(path: string): { sha256: string; bytes: number } {
  const hash = createHash("sha256"); const fd = openSync(path, "r"); const buffer = Buffer.allocUnsafe(64 * 1024); let bytes = 0;
  try { let read = 0; do { read = readSync(fd, buffer, 0, buffer.length, null); if (read) { hash.update(buffer.subarray(0, read)); bytes += read; } } while (read); } finally { closeSync(fd); }
  return { sha256: hash.digest("hex"), bytes };
}
function cleanupOwned(paths: Array<{ path: string; dev: number; ino: number }>): void {
  for (const owned of paths) { try { const stat = lstatSync(owned.path); if (stat.dev === owned.dev && stat.ino === owned.ino) unlinkSync(owned.path); } catch { /* never remove a path we cannot prove we own */ } }
}

export async function exportArchive(options: ArchiveOptions): Promise<ArchiveManifest> {
  const range = validateRange(options.from, options.to, options.now);
  const source = requireRegularFile(options.source, "source database");
  const output = rejectSymlinkComponents(options.out, "output");
  rejectOverlappingOutput(source, output);
  const parent = dirname(output);
  rejectSymlinkComponents(parent, "output parent");
  mkdirSync(parent, { recursive: true });
  rejectSymlinkComponents(parent, "output parent");
  let reserved = false;
  try { mkdirSync(output); reserved = true; } catch (error) { fail(`output already exists or could not be reserved: ${String(error)}`); }
  const staging = mkdtempSync(join(parent, `.${basename(output)}.staging-`));
  const rawPaths = FILES.map((file) => join(staging, file.replace(/\.gz$/, "")));
  const owned: Array<{ path: string; dev: number; ino: number }> = [];
  let db: Database.Database | null = null;
  try {
    db = new Database(source, { readonly: true, fileMustExist: true });
    db.pragma("query_only = ON");
    db.exec("begin");
    const schemaVersion = integer(Number(db.pragma("user_version", { simple: true })), "source schema version");
    const observationExtent = { priceSnapshots: extent(), candles: extent(), oiEvents: extent(), oiOutcomes: extent() };
    const snapshotRange = { min: null as number | null, max: null as number | null }; const candleRange = { min: null as number | null, max: null as number | null }; const eventRange = { min: null as number | null, max: null as number | null }; const outcomeRange = { min: null as number | null, max: null as number | null };
    const snapshotCount = writeLines(rawPaths[0], (write) => snapshotRollups(db!, range.from, range.to, (value) => { const row = value as { first: SnapshotRow; last: SnapshotRow }; updateRange(snapshotRange, row.first.ts); updateRange(snapshotRange, row.last.ts); write(value); }, observationExtent.priceSnapshots));
    const candleCount = writeLines(rawPaths[1], (write) => candles(db!, range.from, range.to, (value) => { updateRange(candleRange, (value as { t: number }).t); write(value); }, observationExtent.candles));
    let eventIds: number[] = [];
    const eventCount = writeLines(rawPaths[2], (write) => { eventIds = events(db!, range.from, range.to, (value) => { updateRange(eventRange, (value as { started_at: number }).started_at); write(value); }, observationExtent.oiEvents); });
    const outcomeCount = writeLines(rawPaths[3], (write) => outcomes(db!, eventIds, (value) => { updateRange(outcomeRange, (value as { target_at: number }).target_at); write(value); }, observationExtent.oiOutcomes));
    db.exec("commit"); db.close(); db = null;
    for (let i = 0; i < FILES.length; i += 1) await gzipFile(rawPaths[i], join(staging, FILES[i]));
    const datasets: Record<DatasetName, DatasetManifest> = {
      snapshots: { file: FILES[0], count: snapshotCount, range: datasetRange(snapshotRange) }, candles: { file: FILES[1], count: candleCount, range: datasetRange(candleRange) }, oiEvents: { file: FILES[2], count: eventCount, range: datasetRange(eventRange) }, oiOutcomes: { file: FILES[3], count: outcomeCount, range: datasetRange(outcomeRange) },
    };
    const manifest: ArchiveManifest = {
      format: ARCHIVE_FORMAT, createdAt: new Date(options.now ?? Date.now()).toISOString(),
      source: { path: source, schemaVersion, observationExtent, observationExtentScope: "selected-range-only" },
      range: { from: range.fromIso, to: range.toIso, fromMs: range.from, toMs: range.to, semantics: "[from,to)" },
      provenance: { historicalIdentity: "legacy-symbol", venueMetadataAvailable: false, volume: "rolling24hVolume_latest_not_summed", rollup: "five-minute-snapshot-rollups_not_raw_snapshots" },
      schema: { rollupMs: ROLLUP_MS, datasets: SCHEMA_DESCRIPTIONS }, datasets,
      files: FILES.map((file, index) => ({ path: file, ...sha256File(join(staging, file)), count: Object.values(datasets)[index].count })),
    };
    const manifestText = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
    writeExclusiveFile(join(staging, "manifest.json"), manifestText);
    // The reserved directory is not committed until manifest.json is present. Links are no-replace.
    for (const file of FILES) {
      const from = join(staging, file); const to = join(output, file); linkSync(from, to); const stat = lstatSync(to); owned.push({ path: to, dev: stat.dev, ino: stat.ino }); unlinkSync(from);
    }
    const manifestPath = join(output, "manifest.json");
    const manifestStat = writeExclusiveFile(manifestPath, manifestText); owned.push({ path: manifestPath, ...manifestStat });
    rmSync(staging, { recursive: true, force: true });
    return manifest;
  } catch (error) {
    try { db?.exec("rollback"); } catch { /* already closed */ }
    try { db?.close(); } catch { /* already closed */ }
    rmSync(staging, { recursive: true, force: true });
    cleanupOwned(owned);
    if (reserved) { try { if (readdirSync(output).length === 0) rmdirSync(output); } catch { /* leave raced/uninspectable paths intact */ } }
    throw error;
  }
}

function safeManifestPath(bundle: string, value: unknown): string {
  if (typeof value !== "string" || value !== basename(value) || value.includes("\\") || !FILES.includes(value as typeof FILES[number])) fail("manifest contains an unsafe file path");
  const path = resolve(bundle, value); if (!inside(bundle, path)) fail("manifest path escapes bundle"); return path;
}
function validateExtent(value: unknown, label: string): SourceExtent {
  const row = assertKeys(value, ["min", "max", "count"], label); const min = nullableFinite(row.min, `${label}.min`); const max = nullableFinite(row.max, `${label}.max`); const count = integer(row.count, `${label}.count`);
  if (count < 0 || (count === 0 && (min !== null || max !== null)) || (count > 0 && (min === null || max === null || min > max))) fail(`${label} has invalid coverage extent`);
  return { min, max, count };
}
function validateDatasetManifest(value: unknown, dataset: DatasetName): DatasetManifest {
  const row = assertKeys(value, ["file", "count", "range"], `datasets.${dataset}`); const file = text(row.file, `datasets.${dataset}.file`); if (file !== FILES[DATASETS.indexOf(dataset)]) fail(`datasets.${dataset}.file does not map to its dataset`);
  const count = integer(row.count, `datasets.${dataset}.count`); if (count < 0) fail(`datasets.${dataset}.count is negative`);
  const range = assertKeys(row.range, ["min", "max"], `datasets.${dataset}.range`); const min = nullableInteger(range.min, `datasets.${dataset}.range.min`); const max = nullableInteger(range.max, `datasets.${dataset}.range.max`);
  if (count === 0 && (min !== null || max !== null)) fail(`datasets.${dataset}.range must be null for an empty dataset`);
  if (count > 0 && (min === null || max === null || min > max)) fail(`datasets.${dataset}.range is invalid`);
  return { file, count, range: { min, max } };
}
function validateManifest(value: unknown): ArchiveManifest {
  const row = assertKeys(value, ["format", "createdAt", "source", "range", "provenance", "schema", "datasets", "files"], "manifest");
  if (row.format !== ARCHIVE_FORMAT) fail("unsupported archive format");
  canonicalIso(row.createdAt, "manifest.createdAt");
  const source = assertKeys(row.source, ["path", "schemaVersion", "observationExtent", "observationExtentScope"], "manifest.source");
  text(source.path, "manifest.source.path"); const schemaVersion = integer(source.schemaVersion, "manifest.source.schemaVersion"); if (schemaVersion < 0) fail("manifest.source.schemaVersion is negative"); if (source.observationExtentScope !== "selected-range-only") fail("manifest.source observation extent scope is unsupported");
  const extents = assertKeys(source.observationExtent, ["priceSnapshots", "candles", "oiEvents", "oiOutcomes"], "manifest.source.observationExtent");
  const observationExtent: Record<string, SourceExtent> = {}; for (const key of Object.keys(extents)) observationExtent[key] = validateExtent(extents[key], `manifest.source.observationExtent.${key}`);
  const range = assertKeys(row.range, ["from", "to", "fromMs", "toMs", "semantics"], "manifest.range");
  const from = canonicalIso(range.from, "manifest.range.from"); const to = canonicalIso(range.to, "manifest.range.to");
  if (integer(range.fromMs, "manifest.range.fromMs") !== from || integer(range.toMs, "manifest.range.toMs") !== to || range.semantics !== "[from,to)") fail("manifest range fields disagree");
  if (from >= to || to - from > MAX_RANGE_MS || to > Date.now()) fail("manifest range is reversed, oversized, or in the future");
  const provenance = assertKeys(row.provenance, ["historicalIdentity", "venueMetadataAvailable", "volume", "rollup"], "manifest.provenance");
  if (provenance.historicalIdentity !== "legacy-symbol" || provenance.venueMetadataAvailable !== false || provenance.volume !== "rolling24hVolume_latest_not_summed" || provenance.rollup !== "five-minute-snapshot-rollups_not_raw_snapshots") fail("manifest provenance is unsupported");
  const schema = assertKeys(row.schema, ["rollupMs", "datasets"], "manifest.schema"); if (integer(schema.rollupMs, "manifest.schema.rollupMs") !== ROLLUP_MS) fail("manifest rollup size is unsupported");
  const schemaDatasets = assertKeys(schema.datasets, DATASETS, "manifest.schema.datasets"); const datasetsSchema: Record<DatasetName, string> = {} as Record<DatasetName, string>; for (const dataset of DATASETS) { if (schemaDatasets[dataset] !== SCHEMA_DESCRIPTIONS[dataset]) fail(`manifest schema description for ${dataset} is unsupported`); datasetsSchema[dataset] = schemaDatasets[dataset] as string; }
  const datasetsRecord = assertKeys(row.datasets, DATASETS, "manifest.datasets"); const datasets: Record<DatasetName, DatasetManifest> = {} as Record<DatasetName, DatasetManifest>; for (const dataset of DATASETS) datasets[dataset] = validateDatasetManifest(datasetsRecord[dataset], dataset);
  if (!Array.isArray(row.files) || row.files.length !== FILES.length) fail("manifest file list is incomplete");
  const files: FileManifest[] = []; const listed = new Set<string>();
  for (const value of row.files) { const file = assertKeys(value, ["path", "sha256", "bytes", "count"], "manifest file"); const path = text(file.path, "manifest file.path"); safeManifestPath("/bundle", path); if (listed.has(path)) fail("manifest contains duplicate files"); listed.add(path); const sha256 = text(file.sha256, `manifest ${path}.sha256`); if (!/^[a-f0-9]{64}$/.test(sha256)) fail(`manifest ${path}.sha256 is invalid`); const bytes = integer(file.bytes, `manifest ${path}.bytes`); const count = integer(file.count, `manifest ${path}.count`); if (bytes < 0 || count < 0) fail(`manifest ${path} has negative size/count`); files.push({ path, sha256, bytes, count }); }
  for (const file of FILES) if (!listed.has(file)) fail(`manifest is missing ${file}`);
  for (const dataset of DATASETS) { const file = files.find((candidate) => candidate.path === datasets[dataset].file)!; if (file.count !== datasets[dataset].count) fail(`manifest file count does not match ${dataset}`); }
  return { format: ARCHIVE_FORMAT, createdAt: row.createdAt as string, source: { path: source.path as string, schemaVersion: source.schemaVersion as number, observationExtent, observationExtentScope: "selected-range-only" }, range: { from: range.from as string, to: range.to as string, fromMs: from, toMs: to, semantics: "[from,to)" }, provenance: provenance as ArchiveManifest["provenance"], schema: { rollupMs: ROLLUP_MS, datasets: datasetsSchema }, datasets, files };
}
function readManifest(bundle: string): ArchiveManifest {
  const root = requireRealDirectory(bundle, "bundle"); const manifestPath = join(root, "manifest.json"); requireRegularFile(manifestPath, "manifest");
  let parsed: unknown; try { parsed = JSON.parse(readFileSync(manifestPath, "utf8")); } catch { fail("manifest is not valid JSON"); }
  return validateManifest(parsed);
}
type ArchiveTestHook = (event: { type: "opened"; dataset: DatasetName; path: string }) => void;
const ARCHIVE_TEST_HOOK = Symbol.for("screener.researchArchive.testHook");
function invokeArchiveTestHook(event: Parameters<ArchiveTestHook>[0]): void {
  const hook = (globalThis as { [key: symbol]: unknown })[ARCHIVE_TEST_HOOK];
  if (typeof hook === "function") (hook as ArchiveTestHook)(event);
}

async function streamVerifiedRecords(path: string, expected: FileManifest, dataset: DatasetName, callback: (record: Record<string, unknown>) => void): Promise<number> {
  const hash = createHash("sha256"); let bytes = 0;
  const source = createReadStream(path);
  source.once("open", () => {
    try { invokeArchiveTestHook({ type: "opened", dataset, path }); }
    catch (error) { source.destroy(error as Error); }
  });
  const hashing = new Transform({ transform(chunk: Buffer, _encoding, done) { hash.update(chunk); bytes += chunk.length; done(null, chunk); } });
  const output = new PassThrough();
  const pump = pipeline(source, hashing, createGunzip(), output);
  const lines = createInterface({ input: output, crlfDelay: Infinity }); let count = 0;
  try {
    for await (const line of lines) {
      if (!line.trim()) fail("JSONL contains an empty line");
      let value: unknown; try { value = JSON.parse(line); } catch { fail("JSONL contains invalid JSON"); }
      if (!value || typeof value !== "object" || Array.isArray(value)) fail("JSONL record is not an object");
      callback(value as Record<string, unknown>); count += 1;
    }
    await pump;
  } catch (error) { await pump.catch(() => undefined); throw error; }
  finally { lines.close(); output.destroy(); }
  const digest = hash.digest("hex");
  if (expected.sha256 !== digest || expected.bytes !== bytes) fail(`${expected.path} failed SHA-256 or size verification`);
  return count;
}

async function walkVerifiedArchive(root: string, manifest: ArchiveManifest, callback: (dataset: DatasetName, record: Record<string, unknown>) => void): Promise<void> {
  const names = new Set(readdirSync(root)); const expected = new Set(["manifest.json", ...FILES]);
  for (const name of names) if (!expected.has(name)) fail(`bundle has unexpected entry ${name}`);
  const fileByPath = new Map(manifest.files.map((file) => [file.path, file]));
  for (let index = 0; index < FILES.length; index += 1) {
    const file = FILES[index]; const path = safeManifestPath(root, file); const entry = fileByPath.get(file);
    if (!entry) fail(`manifest is missing ${file}`);
    requireRegularFile(path, file);
    await streamVerifiedRecords(path, entry, DATASETS[index], (record) => callback(DATASETS[index], record));
  }
}

interface VerificationStats { count: number; range: { min: number | null; max: number | null }; sourceCount: number; sourceRange: { min: number | null; max: number | null }; eventIds: Set<number>; eventStarts: Map<number, number>; }
function stats(): VerificationStats { return { count: 0, range: { min: null, max: null }, sourceCount: 0, sourceRange: { min: null, max: null }, eventIds: new Set(), eventStarts: new Map() }; }
function statValue(target: { min: number | null; max: number | null }, value: number): void { updateRange(target, value); }
function requireInRange(value: number, range: ArchiveManifest["range"], label: string): void { if (value < range.fromMs || value >= range.toMs) fail(`${label} is outside the requested [from,to) range`); }
function compareRange(declared: { min: number | null; max: number | null }, actual: { min: number | null; max: number | null }, label: string): void { if (declared.min !== actual.min || declared.max !== actual.max) fail(`${label} range does not match its records`); }

interface ArchiveValidation {
  sink: (dataset: DatasetName, raw: Record<string, unknown>) => void;
  finish: () => void;
}
function archiveValidation(manifest: ArchiveManifest): ArchiveValidation {
  const snap = stats(); const candle = stats(); const event = stats(); const outcome = stats(); const outcomeKeys = new Set<string>();
  const sink = (dataset: DatasetName, raw: Record<string, unknown>): void => {
    if (dataset === "snapshots") {
      validateSnapshotRecord(raw); const first = raw.first as Record<string, unknown>; const last = raw.last as Record<string, unknown>;
      requireInRange(first.ts as number, manifest.range, "snapshot.first.ts"); requireInRange(last.ts as number, manifest.range, "snapshot.last.ts"); snap.count += 1; snap.sourceCount += raw.snapshot_count as number; statValue(snap.range, first.ts as number); statValue(snap.range, last.ts as number); statValue(snap.sourceRange, first.ts as number); statValue(snap.sourceRange, last.ts as number); return;
    }
    if (dataset === "candles") {
      validateCandleRecord(raw); requireInRange(raw.t as number, manifest.range, "candle.t"); candle.count += 1; statValue(candle.range, raw.t as number); statValue(candle.sourceRange, raw.t as number); candle.sourceCount += 1; return;
    }
    if (dataset === "oiEvents") {
      validateEventRecord(raw); requireInRange(raw.started_at as number, manifest.range, "oi event.started_at"); const id = raw.id as number; if (event.eventIds.has(id)) fail("oi events contain duplicate IDs"); event.eventIds.add(id); event.eventStarts.set(id, raw.started_at as number); event.count += 1; statValue(event.range, raw.started_at as number); statValue(event.sourceRange, raw.started_at as number); event.sourceCount += 1; return;
    }
    const value = validateOutcomeRecord(raw); const eventId = value.event_id as number; const start = event.eventStarts.get(eventId); if (start === undefined) fail("oi outcome references an orphan event"); if ((value.target_at as number) < start) fail("oi outcome target precedes its event"); const key = `${eventId}:${value.horizon}`; if (outcomeKeys.has(key)) fail("oi outcomes contain duplicate event/horizon rows"); outcomeKeys.add(key); outcome.count += 1; statValue(outcome.range, value.target_at as number); statValue(outcome.sourceRange, value.target_at as number); outcome.sourceCount += 1;
  };
  const finish = (): void => {
    const expectedStats: Array<[DatasetName, VerificationStats]> = [["snapshots", snap], ["candles", candle], ["oiEvents", event], ["oiOutcomes", outcome]];
    for (const [dataset, result] of expectedStats) { const declared = manifest.datasets[dataset]; const file = manifest.files.find((candidate) => candidate.path === declared.file)!; if (declared.count !== result.count || file.count !== result.count) fail(`${dataset} count does not match its records`); compareRange(declared.range, result.range, `datasets.${dataset}`); }
    const extents = manifest.source.observationExtent; const sourceChecks: Array<[string, VerificationStats]> = [["priceSnapshots", snap], ["candles", candle], ["oiEvents", event], ["oiOutcomes", outcome]];
    for (const [name, result] of sourceChecks) { const declared = extents[name]; if (declared.count !== result.sourceCount || declared.min !== result.sourceRange.min || declared.max !== result.sourceRange.max) fail(`source observation extent ${name} does not match exported records`); }
  };
  return { sink, finish };
}

export async function verifyArchive(bundle: string): Promise<{ ok: true; manifest: ArchiveManifest }> {
  const root = requireRealDirectory(bundle, "bundle"); const manifest = readManifest(root); const validation = archiveValidation(manifest);
  await walkVerifiedArchive(root, manifest, validation.sink); validation.finish();
  return { ok: true, manifest };
}

export async function replayArchive(options: { bundle: string; out: string }): Promise<void> {
  const bundle = requireRealDirectory(options.bundle, "bundle"); const manifest = readManifest(bundle); const output = rejectSymlinkComponents(options.out, "replay destination"); const bundleReal = realpathSync(bundle);
  if (inside(bundle, output) || inside(bundleReal, resolve(dirname(output)))) fail("replay destination must be outside the immutable bundle");
  const parent = dirname(output); rejectSymlinkComponents(parent, "replay destination parent"); mkdirSync(parent, { recursive: true }); rejectSymlinkComponents(parent, "replay destination parent");
  const tempDir = mkdtempSync(join(parent, `.${basename(output)}.replay-`)); const tempDb = join(tempDir, "database.sqlite"); let db: Database.Database | null = null;
  try {
    db = new Database(tempDb, { fileMustExist: false });
    db.exec(`
      create table research_archive_meta (format text not null, manifest_json text not null, source_schema_version integer not null, range_from text not null, range_to text not null);
      create table research_snapshot_rollups (symbol text not null, bucket_start integer not null, bucket_end integer not null, first_ts integer not null, last_ts integer not null, first_mark real not null, first_oi real, last_mark real not null, last_oi real, mark_min real not null, mark_max real not null, oi_min real, oi_max real, snapshot_count integer not null, coverage_ms integer not null, funding_sample_sum real not null, funding_sample_count integer not null, rolling24h_volume_latest real, first_volume real, last_volume real, first_json text not null, last_json text not null, primary key(symbol,bucket_start));
      create table research_candles (symbol text not null, interval text not null, t integer not null, o real not null, h real not null, l real not null, c real not null, v real not null, primary key(symbol,interval,t));
      create table research_oi_events (id integer primary key, policy_version text not null, source text not null, mode text not null, symbol text not null, sector text not null, started_at integer not null, last_detected_at integer not null, severity text not null, primary_horizon text not null, entry_mark real not null, entry_oi_usd real not null, latest_quadrant text not null, max_oi_coins_change_pct real not null, max_quantity_delta_usd real not null, latest_price_change_pct real not null, volume_24h real not null, funding_hourly real, horizons_json text not null, lanes_json text not null, initial_evidence_json text not null, latest_evidence_json text not null, created_at integer not null, updated_at integer not null, pilot_eligible_at integer);
      create table research_oi_outcomes (event_id integer not null, horizon text not null, target_at integer not null, status text not null, snapshot_at integer, mark real, return_pct real, abs_return_pct real, high_return_pct real, low_return_pct real, observed_at integer not null, note text, primary key(event_id,horizon));
    `);
    db.exec("begin");
    db.prepare("insert into research_archive_meta values (?, ?, ?, ?, ?)").run(manifest.format, JSON.stringify(manifest), manifest.source.schemaVersion, manifest.range.from, manifest.range.to);
    const insertRollup = db.prepare("insert into research_snapshot_rollups values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    const insertCandle = db.prepare("insert into research_candles values (?, ?, ?, ?, ?, ?, ?, ?)");
    const insertEvent = db.prepare(`insert into research_oi_events (${EVENT_COLUMNS.join(",")}) values (${EVENT_COLUMNS.map(() => "?").join(",")})`);
    const insertOutcome = db.prepare(`insert into research_oi_outcomes (${OUTCOME_COLUMNS.join(",")}) values (${OUTCOME_COLUMNS.map(() => "?").join(",")})`);
    const validation = archiveValidation(manifest);
    await walkVerifiedArchive(bundle, manifest, (dataset, raw) => {
      validation.sink(dataset, raw);
      if (dataset === "snapshots") {
        const first = raw.first as Record<string, unknown>; const last = raw.last as Record<string, unknown>;
        insertRollup.run(raw.symbol, raw.bucket_start, raw.bucket_end, first.ts, last.ts, first.mark, first.oi, last.mark, last.oi, raw.mark_min, raw.mark_max, raw.oi_min, raw.oi_max, raw.snapshot_count, (raw.coverage as Record<string, unknown>).duration_ms, raw.funding_sample_sum, raw.funding_sample_count, raw.rolling24h_volume_latest, first.volume, last.volume, JSON.stringify(first), JSON.stringify(last));
      } else if (dataset === "candles") insertCandle.run(raw.symbol, raw.interval, raw.t, raw.o, raw.h, raw.l, raw.c, raw.v);
      else if (dataset === "oiEvents") insertEvent.run(...EVENT_COLUMNS.map((column) => raw[column]));
      else insertOutcome.run(...OUTCOME_COLUMNS.map((column) => raw[column]));
    });
    validation.finish();
    db.exec("commit"); db.close(); db = null;
    // Hard-linking the finished database is the no-replace publication step.
    linkSync(tempDb, output); unlinkSync(tempDb); rmSync(tempDir, { recursive: true, force: true });
  } catch (error) {
    try { db?.exec("rollback"); } catch { /* already rolled back */ }
    try { db?.close(); } catch { /* already closed */ }
    rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
}
