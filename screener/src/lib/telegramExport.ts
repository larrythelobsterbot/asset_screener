import type { NewTelegramAlert } from "./db";

export type TelegramText = string | Array<string | { text?: string; [key: string]: unknown }>;

export interface TelegramExportMessage {
  id?: number | string;
  type?: string;
  date?: string;
  date_unixtime?: string | number;
  text?: TelegramText;
  [key: string]: unknown;
}

export interface ParsedTelegramAlert {
  messageId: number;
  date: string;
  timestamp: number;
  normalizedDate: string;
  timestampSource: "date_unixtime" | "date" | "date+default-offset";
  symbol: string;
  direction: "LONG" | "SHORT";
  entry: number;
  stop: number;
  target: number;
  score: number;
  label: string;
}

export interface SkippedTelegramMessage {
  messageId: number | string | null;
  reason: "not a user message" | "missing or invalid alert fields" | "invalid prices or direction geometry";
}

export interface TelegramParseOptions {
  /** Offset in minutes for legacy zone-less Telegram dates; omit to reject them. */
  defaultOffsetMinutes?: number;
}

export interface TelegramExportResult {
  alerts: ParsedTelegramAlert[];
  skipped: SkippedTelegramMessage[];
}

function textOf(value: TelegramText | undefined): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((part) => typeof part === "string" ? part : typeof part?.text === "string" ? part.text : "").join("");
}

function withoutMarkup(value: string): string {
  return value.replace(/<[^>]*>/g, "").replace(/\u00a0/g, " ");
}

function numberFrom(value: string): number | null {
  const number = Number(value.replace(/[$,%\s,]/g, ""));
  return Number.isFinite(number) ? number : null;
}

function findNumber(text: string, field: "entry" | "stop" | "target"): number | null {
  const match = text.match(new RegExp(`\\b${field}\\s*:\\s*\\$?(-?[\\d,]+(?:\\.\\d+)?)`, "i"));
  return match ? numberFrom(match[1]) : null;
}

function messageIdOf(id: unknown): number | null {
  const value = typeof id === "number" ? id : typeof id === "string" && /^\d+$/.test(id) ? Number(id) : NaN;
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function formatOffset(minutes: number): string {
  if (!Number.isInteger(minutes) || minutes < -1439 || minutes > 1439) return "";
  const sign = minutes < 0 ? "-" : "+";
  const absolute = Math.abs(minutes);
  return `${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`;
}

function timestampOf(message: TelegramExportMessage, options: TelegramParseOptions): { timestamp: number; source: ParsedTelegramAlert["timestampSource"] } | null {
  const unix = typeof message.date_unixtime === "number" || typeof message.date_unixtime === "string"
    ? Number(message.date_unixtime) : NaN;
  if (Number.isSafeInteger(unix) && unix > 0 && unix < 10_000_000_000) {
    return { timestamp: unix * 1_000, source: "date_unixtime" };
  }
  if (typeof message.date !== "string") return null;
  const explicitZone = /(?:Z|[+-][0-9]{2}:?[0-9]{2})$/i.test(message.date);
  if (!explicitZone && options.defaultOffsetMinutes === undefined) return null;
  const offset = explicitZone ? "" : formatOffset(options.defaultOffsetMinutes as number);
  if (!explicitZone && !offset) return null;
  const timestamp = Date.parse(message.date + offset);
  return Number.isFinite(timestamp)
    ? { timestamp, source: explicitZone ? "date" : "date+default-offset" } : null;
}

function invalidGeometry(direction: "LONG" | "SHORT", entry: number, stop: number, target: number): boolean {
  if (entry <= 0 || stop <= 0 || target <= 0) return true;
  return direction === "LONG" ? !(stop < entry && entry < target) : !(target < entry && entry < stop);
}

function parseTelegramMessageInternal(message: TelegramExportMessage, options: TelegramParseOptions): { alert: ParsedTelegramAlert | null; reason: SkippedTelegramMessage["reason"] } {
  const messageId = messageIdOf(message.id);
  const parsedTime = timestampOf(message, options);
  if (messageId === null || typeof message.date !== "string" || parsedTime === null) {
    return { alert: null, reason: "missing or invalid alert fields" };
  }
  const text = withoutMarkup(textOf(message.text));
  const headline = text.match(/(STRONG\s+(?:BUY|SELL))\s*[·|]\s*(LONG|SHORT)\s*[·|]\s*score\s*([+-]?[\d.]+)/i);
  const symbolMatch = text.match(/(?:^|\n)\s*([A-Za-z0-9][A-Za-z0-9_.:-]{1,31})\s*[·|]\s*[^\n]*?@/);
  const entry = findNumber(text, "entry");
  const stop = findNumber(text, "stop");
  const target = findNumber(text, "target");
  if (!headline || !symbolMatch || entry === null || stop === null || target === null) return { alert: null, reason: "missing or invalid alert fields" };
  const score = numberFrom(headline[3]);
  if (score === null) return { alert: null, reason: "missing or invalid alert fields" };
  const direction = headline[2].toUpperCase() as "LONG" | "SHORT";
  if (invalidGeometry(direction, entry, stop, target)) return { alert: null, reason: "invalid prices or direction geometry" };
  return { reason: "missing or invalid alert fields", alert: {
    messageId, date: message.date, timestamp: parsedTime.timestamp,
    normalizedDate: new Date(parsedTime.timestamp).toISOString(), timestampSource: parsedTime.source,
    symbol: symbolMatch[1].toUpperCase(), direction, entry, stop, target, score,
    label: headline[1].replace(/\s+/g, " ").toUpperCase(),
  }};
}

/** Parse one Telegram Desktop export message, returning null for non-alert messages. */
export function parseTelegramMessage(message: TelegramExportMessage, options: TelegramParseOptions = {}): ParsedTelegramAlert | null {
  return parseTelegramMessageInternal(message, options).alert;
}

/** Parse a Telegram Desktop result.json export and retain an audit trail of skips. */
export function parseTelegramExport(input: unknown, options: TelegramParseOptions = {}): TelegramExportResult {
  const messages = input && typeof input === "object" && Array.isArray((input as { messages?: unknown }).messages)
    ? (input as { messages: unknown[] }).messages
    : [];
  const alerts: ParsedTelegramAlert[] = [];
  const skipped: SkippedTelegramMessage[] = [];

  for (const raw of messages) {
    const message = raw && typeof raw === "object" ? raw as TelegramExportMessage : {};
    const id = typeof message.id === "number" || typeof message.id === "string" ? message.id : null;
    if (message.type !== "message") {
      skipped.push({ messageId: id, reason: "not a user message" });
      continue;
    }
    const parsed = parseTelegramMessageInternal(message, options);
    if (parsed.alert) alerts.push(parsed.alert);
    else skipped.push({ messageId: id, reason: parsed.reason });
  }
  return { alerts, skipped };
}

export function toBackfilledTelegramAlert(alert: ParsedTelegramAlert): NewTelegramAlert {
  return {
    created_at: alert.timestamp,
    delivery_status: "delivered",
    delivered_at: alert.timestamp,
    delivery_error: null,
    telegram_message_id: String(alert.messageId),
    symbol: alert.symbol,
    sector: null,
    direction: alert.direction === "LONG" ? "long" : "short",
    entry_price: alert.entry,
    stop_price: alert.stop,
    target_price: alert.target,
    size: null,
    risk_usd: null,
    conviction_score: alert.score,
    conviction_json: JSON.stringify({ label: alert.label, score: alert.score, source: "telegram_export_backfill", original_date: alert.date, normalized_date: alert.normalizedDate, timestamp_source: alert.timestampSource }),
    signal_json: null,
    family_json: null,
    expires_at: alert.timestamp + 48 * 60 * 60 * 1000,
    outcome_status: "open",
    outcome_at: null,
    outcome_price: null,
    pnl_r: null,
    evaluated_through: null,
    outcome_note: "Backfilled from Telegram export; outcome not yet evaluated.",
    outcome_provenance: "telegram_export_backfill",
  };
}
