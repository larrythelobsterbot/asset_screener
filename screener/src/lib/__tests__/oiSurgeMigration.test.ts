import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

test("populated V26 OI events migrate to V28 as permanently ineligible", async () => {
  const root = mkdtempSync(join(tmpdir(), "oi-surge-v26-migration-"));
  const path = join(root, "screener.db");
  const previousPath = process.env.SCREENER_DB_PATH;
  const seed = new Database(path);
  seed.exec(`
    create table oi_surge_events (
      id integer primary key autoincrement,
      symbol text not null,
      severity text not null
    );
    insert into oi_surge_events (symbol, severity) values ('BTC', 'extreme');
    pragma user_version = 26;
  `);
  seed.close();
  process.env.SCREENER_DB_PATH = path;

  let migrated: Database.Database | null = null;
  try {
    const { getDb } = await import("../db");
    migrated = getDb();
    assert.equal(migrated.pragma("user_version", { simple: true }), 28);
    const columns = migrated.pragma("table_info(oi_surge_events)") as Array<{ name: string }>;
    assert.equal(columns.some(({ name }) => name === "pilot_eligible_at"), true);
    const row = migrated.prepare(`
      select symbol, severity, pilot_eligible_at from oi_surge_events where id = 1
    `).get() as { symbol: string; severity: string; pilot_eligible_at: number | null };
    assert.deepEqual(row, { symbol: "BTC", severity: "extreme", pilot_eligible_at: null });
    const deliveryTable = migrated.prepare(`
      select count(*) as count from sqlite_master
      where type = 'table' and name = 'oi_surge_deliveries'
    `).get() as { count: number };
    assert.equal(deliveryTable.count, 1);
  } finally {
    migrated?.close();
    if (previousPath === undefined) delete process.env.SCREENER_DB_PATH;
    else process.env.SCREENER_DB_PATH = previousPath;
    rmSync(root, { recursive: true, force: true });
  }
});
