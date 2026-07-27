#!/usr/bin/env npx tsx

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  parseTelegramExport,
  toBackfilledTelegramAlert,
  type TelegramExportResult,
} from "../src/lib/telegramExport";
import { insertTelegramAlert } from "../src/lib/db";

interface CliOptions {
  file: string | null;
  apply: boolean;
  defaultOffsetMinutes?: number;
}

function parseOffset(value: string): number {
  const match = value.match(/^([+-])(\d{2}):(\d{2})$/);
  if (!match || Number(match[2]) > 23 || Number(match[3]) > 59) throw new Error("default offset must be ±HH:MM");
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === "-" ? -minutes : minutes;
}

function parseArgs(argv: string[]): CliOptions {
  let file: string | null = null;
  let apply = false;
  let defaultOffsetMinutes: number | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") apply = true;
    else if (arg === "--file" && argv[i + 1]) file = argv[++i];
    else if (arg === "--default-offset" && argv[i + 1]) defaultOffsetMinutes = parseOffset(argv[++i]);
    else if (!arg.startsWith("-") && file === null) file = arg;
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: npx tsx scripts/backfill-telegram-alerts.ts [--file result.json] [--apply] [--default-offset ±HH:MM]");
      console.log("Default mode is a read-only dry run. --apply inserts parsed alerts idempotently by Telegram message id.");
      console.log("Telegram date strings must include a timezone; --default-offset supplies an explicit offset for legacy zone-less dates.");
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!file) throw new Error("an export file is required (pass --file result.json)");
  return { file, apply, defaultOffsetMinutes };
}

export function formatDryRun(result: TelegramExportResult): string {
  const lines = [
    `dry-run: parsed ${result.alerts.length} alert(s), skipped ${result.skipped.length} message(s)`,
  ];
  for (const alert of result.alerts) {
    lines.push(`would import message ${alert.messageId}: ${alert.symbol} ${alert.direction} entry=${alert.entry} stop=${alert.stop} target=${alert.target} score=${alert.score} label=${alert.label}`);
  }
  for (const skipped of result.skipped) {
    lines.push(`skipped message ${skipped.messageId ?? "?"}: ${skipped.reason}`);
  }
  return lines.join("\n");
}

export async function run(argv = process.argv.slice(2)): Promise<number> {
  const options = parseArgs(argv);
  const file = options.file;
  if (!file) throw new Error("an export file is required (pass --file result.json)");
  const input = JSON.parse(await readFile(resolve(file), "utf8")) as unknown;
  const result = parseTelegramExport(input, { defaultOffsetMinutes: options.defaultOffsetMinutes });
  if (!options.apply) {
    console.log(formatDryRun(result));
    return 0;
  }

  let inserted = 0;
  let duplicates = 0;
  for (const alert of result.alerts) {
    try {
      insertTelegramAlert(toBackfilledTelegramAlert(alert));
      inserted += 1;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
      if (code.includes("SQLITE_CONSTRAINT_UNIQUE")) {
        duplicates += 1;
        continue;
      }
      throw error;
    }
  }
  console.log(
    `apply: inserted ${inserted} alert(s), skipped ${duplicates} duplicate(s), ` +
    `${result.skipped.length} unparseable/non-alert message(s)`,
  );
  return 0;
}

const entrypoint = process.argv[1];
if (entrypoint && resolve(entrypoint) === resolve(new URL(import.meta.url).pathname)) {
  run().catch((error: unknown) => {
    console.error(`backfill failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
