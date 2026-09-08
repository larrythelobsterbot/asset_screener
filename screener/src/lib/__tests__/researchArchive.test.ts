import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { exportArchive, replayArchive, verifyArchive } from "../researchArchive";

function fixture(): { root: string; source: string } {
  const root = mkdtempSync(join(tmpdir(), "research-archive-test-"));
  const source = join(root, "source.db");
  const db = new Database(source);
  db.exec(`
    create table price_snapshots (
      symbol text not null, ts integer not null, mark real not null,
      prev_day real, funding real, oi real, volume real
    );
    create table candles_cache (
      symbol text not null, interval text not null, t integer not null,
      o real not null, h real not null, l real not null, c real not null, v real not null
    );
    create table oi_surge_events (
      id integer primary key, policy_version text not null, source text not null,
      mode text not null, symbol text not null, sector text not null,
      started_at integer not null, last_detected_at integer not null,
      severity text not null, primary_horizon text not null, entry_mark real not null,
      entry_oi_usd real not null, latest_quadrant text not null,
      max_oi_coins_change_pct real not null, max_quantity_delta_usd real not null,
      latest_price_change_pct real not null, volume_24h real not null,
      funding_hourly real, horizons_json text not null, lanes_json text not null,
      initial_evidence_json text not null, latest_evidence_json text not null,
      created_at integer not null, updated_at integer not null, pilot_eligible_at integer
    );
    create table oi_surge_outcomes (
      event_id integer not null, horizon text not null, target_at integer not null,
      status text not null, snapshot_at integer, mark real, return_pct real,
      abs_return_pct real, high_return_pct real, low_return_pct real,
      observed_at integer not null, note text, primary key(event_id, horizon)
    );
    pragma user_version = 28;
  `);
  const insert = db.prepare("insert into price_snapshots values (?, ?, ?, ?, ?, ?, ?)");
  insert.run("BTC", 300_000, 100, 99, 0.001, 10, 100);
  insert.run("BTC", 301_000, 101, 99, null, null, 200);
  insert.run("BTC", 302_000, 102, 99, 0.002, 12, 150);
  insert.run("ETH", 301_000, 2_000, null, 0.003, 20, 7);
  db.prepare("insert into candles_cache values (?, ?, ?, ?, ?, ?, ?, ?)").run("BTC", "5m", 301_000, 100, 102, 99, 101, 3.5);
  db.prepare(`insert into oi_surge_events values (${Array.from({ length: 25 }, () => "?").join(", ")})`)
    .run(7, "oi-v1", "detector", "shadow", "BTC", "crypto", 301_000, 301_000,
      "high", "1h", 100, 1000, "expanding_up", 5, 50, 1, 2000, 0.001,
      '[{"horizon":"1h"}]', '[{"lane":"crypto"}]', '{"mark":100,"oi":10}', '{"mark":101,"oi":11}', 301_000, 301_000, null);
  db.prepare("insert into oi_surge_outcomes values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(7, "1h", 302_000, "observed", 302_000, 102, 2, 2, 3, -1, 303_000, "ok");
  db.close();
  return { root, source };
}

function rewriteManifest(bundle: string, mutate: (manifest: Record<string, unknown>) => void): void {
  const path = join(bundle, "manifest.json");
  const manifest = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  mutate(manifest);
  writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n");
}

function rewriteGzip(bundle: string, file: string, mutate: (records: Record<string, unknown>[]) => void): void {
  const path = join(bundle, file);
  const records = gunzipSync(readFileSync(path)).toString("utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  mutate(records);
  const compressed = gzipSync(Buffer.from(records.map((record) => JSON.stringify(record)).join("\n") + "\n"), { level: 9 });
  writeFileSync(path, compressed);
  rewriteManifest(bundle, (manifest) => {
    const files = manifest.files as Array<Record<string, unknown>>;
    const entry = files.find((candidate) => candidate.path === file);
    assert.ok(entry);
    entry.sha256 = createHash("sha256").update(compressed).digest("hex");
    entry.bytes = compressed.length;
  });
}

function gzipRecords(bundle: string, file: string, mutate: (records: Record<string, unknown>[]) => void): Buffer {
  const records = gunzipSync(readFileSync(join(bundle, file))).toString("utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  mutate(records);
  return gzipSync(Buffer.from(records.map((record) => JSON.stringify(record)).join("\n") + "\n"), { level: 9 });
}

const archiveTestHook = Symbol.for("screener.researchArchive.testHook");
function setArchiveTestHook(hook: ((event: { type: "opened"; dataset: string; path: string }) => void) | undefined): void {
  const globals = globalThis as { [key: symbol]: unknown };
  if (hook) globals[archiveTestHook] = hook; else delete globals[archiveTestHook];
}

const exportArgs = (source: string, out: string) => ({ source, out, from: new Date(0).toISOString(), to: new Date(400_000).toISOString(), now: 400_001 });

test("early invalid record cancels a large stream without waiting for its unread tail", { timeout: 3000 }, async () => {
  const { root, source } = fixture(); const bundle = join(root, "bundle");
  try {
    await exportArchive(exportArgs(source, bundle));
    rewriteGzip(bundle, "snapshots.jsonl.gz", records => {
      records[0] = {};
      for (let i = 0; i < 10_000; i++) records.push({ padding: "x".repeat(1000) });
    });
    await assert.rejects(verifyArchive(bundle), /snapshot|keys|fields/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("distinct funded endpoints sharing a timestamp cannot count as one sample", async () => {
  const { root, source } = fixture(); const bundle = join(root, "bundle");
  try {
    const db = new Database(source);
    db.prepare("delete from price_snapshots where symbol = 'BTC'").run();
    const insert = db.prepare("insert into price_snapshots values (?, ?, ?, ?, ?, ?, ?)");
    insert.run("BTC", 300_000, 100, 99, 0.001, 10, 100);
    insert.run("BTC", 300_000, 101, 99, 0.002, 11, 101);
    db.close();
    await exportArchive(exportArgs(source, bundle));
    rewriteGzip(bundle, "snapshots.jsonl.gz", records => { records.find(row => row.symbol === "BTC")!.funding_sample_count = 1; });
    await assert.rejects(verifyArchive(bundle), /funding sample count/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("export verifies and replays bounded rollups without summing rolling volume", async () => {
  const { root, source } = fixture();
  const bundle = join(root, "bundle");
  const replay = join(root, "research.db");
  try {
    const manifest = await exportArchive(exportArgs(source, bundle));
    assert.equal(manifest.provenance.historicalIdentity, "legacy-symbol");
    assert.equal(manifest.datasets.snapshots.count, 2);
    assert.equal(manifest.datasets.candles.count, 1);
    assert.equal(manifest.datasets.oiEvents.count, 1);
    assert.equal(manifest.datasets.oiOutcomes.count, 1);
    assert.deepEqual(await verifyArchive(bundle), { ok: true, manifest });
    await replayArchive({ bundle, out: replay });
    const db = new Database(replay, { readonly: true, fileMustExist: true });
    const rollup = db.prepare("select * from research_snapshot_rollups where symbol = 'BTC'").all() as Array<Record<string, unknown>>;
    assert.equal(rollup.length, 1); assert.equal(rollup[0].rolling24h_volume_latest, 150); assert.equal(rollup[0].oi_min, 10); assert.equal(rollup[0].oi_max, 12);
    assert.equal((db.prepare("select count(*) as n from research_candles").get() as { n: number }).n, 1);
    assert.equal((db.prepare("select count(*) as n from research_oi_events").get() as { n: number }).n, 1);
    assert.equal((db.prepare("select count(*) as n from research_oi_outcomes").get() as { n: number }).n, 1);
    const replayedRollup = db.prepare("select first_json, last_json from research_snapshot_rollups where symbol = 'BTC'").get() as { first_json: string; last_json: string };
    assert.deepEqual(JSON.parse(replayedRollup.first_json), { symbol: "BTC", ts: 300_000, mark: 100, prev_day: 99, funding: 0.001, oi: 10, volume: 100 });
    assert.deepEqual(JSON.parse(replayedRollup.last_json), { symbol: "BTC", ts: 302_000, mark: 102, prev_day: 99, funding: 0.002, oi: 12, volume: 150 });
    const evidence = db.prepare("select symbol, initial_evidence_json from research_oi_events").get() as { symbol: string; initial_evidence_json: string };
    assert.deepEqual(evidence, { symbol: "BTC", initial_evidence_json: '{"mark":100,"oi":10}' });
    db.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("verification catches corruption and unsafe manifest paths", async () => {
  const { root, source } = fixture(); const bundle = join(root, "bundle");
  try {
    await exportArchive(exportArgs(source, bundle));
    const manifestPath = join(bundle, "manifest.json"); const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { files: Array<{ path: string }> };
    manifest.files[0].path = "../outside.gz"; writeFileSync(manifestPath, JSON.stringify(manifest));
    await assert.rejects(() => verifyArchive(bundle), /unsafe|path|missing/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("failed export never publishes a partial bundle", async () => {
  const { root, source } = fixture(); const bundle = join(root, "bundle"); const db = new Database(source);
  db.prepare("update oi_surge_events set initial_evidence_json = ? where id = 7").run("not-json"); db.close();
  try {
    await assert.rejects(() => exportArchive(exportArgs(source, bundle)), /JSON|evidence/i);
    assert.equal(existsSync(bundle), false); assert.equal(readFileSync(source).length > 0, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("range validation rejects future and oversized exports", async () => {
  const { root, source } = fixture();
  try {
    await assert.rejects(() => exportArchive({ ...exportArgs(source, join(root, "future")), to: new Date(500_000).toISOString() }), /future/i);
    await assert.rejects(() => exportArchive({ ...exportArgs(source, join(root, "large")), to: new Date(32 * 86_400_000).toISOString(), now: 32 * 86_400_000 + 1 }), /31 days|bounded|range/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("verification rejects gzip corruption and logical tampering even when hashes are recomputed", async () => {
  const { root, source } = fixture();
  try {
    const corrupt = join(root, "corrupt"); await exportArchive(exportArgs(source, corrupt));
    const badGzip = Buffer.from("not a gzip stream"); writeFileSync(join(corrupt, "candles.jsonl.gz"), badGzip);
    rewriteManifest(corrupt, (manifest) => { const entry = (manifest.files as Array<Record<string, unknown>>).find((candidate) => candidate.path === "candles.jsonl.gz")!; entry.sha256 = createHash("sha256").update(badGzip).digest("hex"); entry.bytes = badGzip.length; });
    await assert.rejects(() => verifyArchive(corrupt), /gzip|unexpected|invalid|end|header|check/i);
    const logical = join(root, "logical"); await exportArchive(exportArgs(source, logical));
    rewriteGzip(logical, "snapshots.jsonl.gz", (records) => { records[0] = {}; });
    await assert.rejects(() => verifyArchive(logical), /missing|snapshot/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("snapshot validation rejects recomputed-hash OI null/range and funding inconsistencies", async () => {
  const { root, source } = fixture();
  try {
    const oiNull = join(root, "oi-null"); await exportArchive(exportArgs(source, oiNull));
    rewriteGzip(oiNull, "snapshots.jsonl.gz", (records) => { records[0].oi_min = null; });
    await assert.rejects(() => verifyArchive(oiNull), /OI range|non-null/i);

    const oiOutside = join(root, "oi-outside"); await exportArchive(exportArgs(source, oiOutside));
    rewriteGzip(oiOutside, "snapshots.jsonl.gz", (records) => { (records[0].first as Record<string, unknown>).oi = 999; });
    await assert.rejects(() => verifyArchive(oiOutside), /OI range|contain/i);

    const fundingEndpoints = join(root, "funding-endpoints"); await exportArchive(exportArgs(source, fundingEndpoints));
    rewriteGzip(fundingEndpoints, "snapshots.jsonl.gz", (records) => { records[0].funding_sample_count = 1; });
    await assert.rejects(() => verifyArchive(fundingEndpoints), /funding sample count|funded endpoints/i);

    const fundingSingle = join(root, "funding-single"); await exportArchive(exportArgs(source, fundingSingle));
    rewriteGzip(fundingSingle, "snapshots.jsonl.gz", (records) => { records[1].funding_sample_count = 0; });
    await assert.rejects(() => verifyArchive(fundingSingle), /single-snapshot funding|funding sample count/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("verification uses the bytes from one opened stream despite replacement", async () => {
  const { root, source } = fixture(); const bundle = join(root, "bundle");
  try {
    await exportArchive(exportArgs(source, bundle));
    const replacement = gzipSync(Buffer.from("{}\n")); let fired = false;
    setArchiveTestHook((event) => {
      if (!fired && event.dataset === "snapshots") { fired = true; renameSync(event.path, `${event.path}.opened`); writeFileSync(event.path, replacement); }
    });
    await verifyArchive(bundle);
    assert.equal(fired, true);
  } finally { setArchiveTestHook(undefined); rmSync(root, { recursive: true, force: true }); }
});

test("replay inserts only the validated bytes when a bundle path is replaced", async () => {
  const { root, source } = fixture(); const bundle = join(root, "bundle"); const replay = join(root, "replayed.db");
  try {
    await exportArchive(exportArgs(source, bundle));
    const replacement = gzipRecords(bundle, "snapshots.jsonl.gz", (records) => { (records[0].first as Record<string, unknown>).mark = 101; }); let fired = false;
    setArchiveTestHook((event) => {
      if (!fired && event.dataset === "snapshots") { fired = true; renameSync(event.path, `${event.path}.opened`); writeFileSync(event.path, replacement); }
    });
    await replayArchive({ bundle, out: replay });
    const db = new Database(replay, { readonly: true, fileMustExist: true });
    assert.equal((db.prepare("select first_mark from research_snapshot_rollups where symbol = 'BTC'").get() as { first_mark: number }).first_mark, 100);
    db.close(); assert.equal(fired, true);
  } finally { setArchiveTestHook(undefined); rmSync(root, { recursive: true, force: true }); }
});
test("verification rejects reversed or future manifest ranges and unknown schema keys", async () => {
  const { root, source } = fixture();
  try {
    const reversed = join(root, "reversed"); await exportArchive(exportArgs(source, reversed));
    rewriteManifest(reversed, (manifest) => { const range = manifest.range as Record<string, unknown>; range.from = new Date(400_000).toISOString(); range.to = new Date(0).toISOString(); range.fromMs = 400_000; range.toMs = 0; });
    await assert.rejects(() => verifyArchive(reversed), /reversed|range/i);
    const future = join(root, "future-manifest"); await exportArchive(exportArgs(source, future));
    rewriteManifest(future, (manifest) => { const range = manifest.range as Record<string, unknown>; range.from = new Date(Date.now() + 60_000).toISOString(); range.to = new Date(Date.now() + 120_000).toISOString(); range.fromMs = Date.parse(range.from as string); range.toMs = Date.parse(range.to as string); });
    await assert.rejects(() => verifyArchive(future), /future|range/i);
    const unknown = join(root, "unknown-schema"); await exportArchive(exportArgs(source, unknown));
    rewriteManifest(unknown, (manifest) => { (manifest.schema as Record<string, unknown>).unexpected = "accepted?"; });
    await assert.rejects(() => verifyArchive(unknown), /unknown|schema/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("orphan outcomes fail, while linked late outcomes remain verifiable", async () => {
  const { root, source } = fixture();
  try {
    const late = join(root, "late"); const manifest = await exportArchive({ source, out: late, from: new Date(300_000).toISOString(), to: new Date(301_500).toISOString(), now: 400_001 });
    assert.equal(manifest.datasets.oiOutcomes.count, 1); assert.equal(manifest.datasets.oiOutcomes.range.max, 302_000); await verifyArchive(late);
    const orphan = join(root, "orphan"); await exportArchive(exportArgs(source, orphan));
    rewriteGzip(orphan, "oi-outcomes.jsonl.gz", (records) => { records[0].event_id = 999; });
    await assert.rejects(() => verifyArchive(orphan), /orphan|event/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("source, bundle, output, and replay paths reject symlink aliases including broken links", async () => {
  const { root, source } = fixture();
  try {
    const sourceAlias = join(root, "source-alias.db"); symlinkSync(source, sourceAlias);
    await assert.rejects(() => exportArchive({ ...exportArgs(sourceAlias, join(root, "alias-source-out")) }), /symlink/i);
    const broken = join(root, "broken.db"); symlinkSync(join(root, "missing.db"), broken);
    await assert.rejects(() => exportArchive({ ...exportArgs(broken, join(root, "broken-out")) }), /symlink/i);
    const bundle = join(root, "bundle"); await exportArchive(exportArgs(source, bundle));
    const bundleAlias = join(root, "bundle-alias"); symlinkSync(bundle, bundleAlias); await assert.rejects(() => verifyArchive(bundleAlias), /symlink/i);
    const outParent = join(root, "out-parent"); symlinkSync(root, outParent); await assert.rejects(() => replayArchive({ bundle, out: join(outParent, "replayed.db") }), /symlink/i);
    const brokenParent = join(root, "broken-parent"); symlinkSync(join(root, "no-parent"), brokenParent); await assert.rejects(() => replayArchive({ bundle, out: join(brokenParent, "replayed.db") }), /symlink/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("publication refuses pre-existing paths without clobbering them", async () => {
  const { root, source } = fixture();
  try {
    const bundle = join(root, "reserved"); mkdirSync(bundle);
    await assert.rejects(() => exportArchive(exportArgs(source, bundle)), /exists|reserved/i); assert.deepEqual(readdirSync(bundle), []);
    const valid = join(root, "valid"); await exportArchive(exportArgs(source, valid)); const destination = join(root, "existing.db"); writeFileSync(destination, "do not clobber");
    await assert.rejects(() => replayArchive({ bundle: valid, out: destination }), /exist|new path|SQLITE/i); assert.equal(readFileSync(destination, "utf8"), "do not clobber");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("bounded source extents exclude observations outside the requested interval", async () => {
  const { root, source } = fixture(); const db = new Database(source);
  db.prepare("insert into price_snapshots values (?, ?, ?, ?, ?, ?, ?)").run("BTC", 9_000_000_000_000, 1, 1, null, 1, 1); db.close();
  try {
    const manifest = await exportArchive(exportArgs(source, join(root, "bounded")));
    assert.deepEqual(manifest.source.observationExtent.priceSnapshots, { min: 300_000, max: 302_000, count: 4 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
