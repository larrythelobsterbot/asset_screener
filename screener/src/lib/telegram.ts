// Minimal Telegram Bot API client for outbound alerts.
//
// Config comes from env vars, NEVER from a file the code path touches:
//   TELEGRAM_BOT_TOKEN  – the bot's HTTP API token (from @BotFather)
//   TELEGRAM_CHAT_ID    – destination chat id (your personal user id, a group, or a channel)
//
// If either is unset, sendTelegramMessage() logs once and no-ops on
// subsequent calls. This means the alerter code can be hooked into the
// signals route unconditionally — production with env set fires alerts;
// dev / tests / first-deploy-before-config does nothing.
//
// We do NOT use any Telegram SDK — a single fetch() with an HTML-parsed
// body is enough, avoids a dep that would also need careful escaping of
// the chat id and token at install time.

import { fetchWithTimeout } from "./fetchWithTimeout";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

let warnedMissing = false;
let totalSent = 0;
let totalFailed = 0;

function warnOnce(): void {
  if (warnedMissing) return;
  warnedMissing = true;
  const missing = [
    !BOT_TOKEN && "TELEGRAM_BOT_TOKEN",
    !CHAT_ID && "TELEGRAM_CHAT_ID",
  ].filter(Boolean).join(", ");
  console.warn(
    `[telegram] ${missing} not set — alerts disabled. ` +
    `Set both env vars and restart the process to enable.`
  );
}

export function isTelegramConfigured(): boolean {
  return !!BOT_TOKEN && !!CHAT_ID;
}

// Escape characters that would otherwise be parsed as HTML by Telegram's
// renderer. We use parse_mode=HTML (not MarkdownV2) because the HTML
// charset is smaller and the escaping rules are well-known. We deliberately
// leave the tags <b>, <i>, <code>, <pre>, <a> intact for callers that
// pass them in directly — only the dynamic VALUES they wrap should pass
// through this helper.
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface SendOptions {
  parseMode?: "HTML" | "MarkdownV2";
  // Disables preview rendering for any URLs in the message — useful for
  // alerts where the URL is functional, not editorial.
  disableLinkPreview?: boolean;
  // Disables push notifications for this single message — caller can
  // opt-in to "quiet" delivery for less-important alerts.
  silent?: boolean;
  // Optional override of the default chat id, e.g. to route certain
  // alert categories to a separate channel later. Defaults to TELEGRAM_CHAT_ID.
  chatId?: string;
}

export interface SendResult {
  ok: boolean;
  // Telegram error description on failure, undefined on success.
  error?: string;
  // The returned message_id on success — useful if a caller wants to
  // edit / delete the alert later (e.g., trade-position lifecycle).
  messageId?: number;
  // `rejected` means Telegram returned an explicit negative ACK. `unknown`
  // means the request may have reached Telegram but no authoritative ACK was
  // received (timeout/network/protocol failure), so automatic retry can
  // duplicate a message that was actually accepted.
  failureKind?: "rejected" | "unknown";
}

// Sends a text message to the configured chat. Returns a result object
// instead of throwing — alert delivery should never crash the calling
// route. Network errors and Telegram API errors are surfaced via .error.
export async function sendTelegramMessage(
  text: string,
  opts: SendOptions = {}
): Promise<SendResult> {
  if (!BOT_TOKEN || !CHAT_ID) {
    warnOnce();
    return { ok: false, error: "telegram not configured", failureKind: "rejected" };
  }

  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const body = {
    chat_id: opts.chatId ?? CHAT_ID,
    text,
    parse_mode: opts.parseMode ?? "HTML",
    // Telegram's API uses 'disable_web_page_preview' (legacy) — newer field
    // 'link_preview_options' exists but the legacy one still works and is
    // less verbose. Stick with legacy for now.
    disable_web_page_preview: opts.disableLinkPreview ?? false,
    disable_notification: opts.silent ?? false,
  };

  try {
    const res = await fetchWithTimeout(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      // Opt out of Next.js fetch caching — same policy as every other
      // outbound integration in this codebase. Telegram responses are
      // one-shot ACKs we never want a cached version of.
      cache: "no-store",
    }, 10_000); // 10s — alerts are time-sensitive; better to fail fast than hang
    const json = (await res.json()) as
      | { ok: true; result: { message_id: number } }
      | { ok: false; description: string };
    if (!json.ok) {
      totalFailed += 1;
      return { ok: false, error: json.description, failureKind: "rejected" };
    }
    totalSent += 1;
    return { ok: true, messageId: json.result.message_id };
  } catch (err) {
    totalFailed += 1;
    return { ok: false, error: String(err), failureKind: "unknown" };
  }
}

export function getTelegramStats(): { sent: number; failed: number; configured: boolean } {
  return { sent: totalSent, failed: totalFailed, configured: isTelegramConfigured() };
}
