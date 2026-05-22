// One-shot helper to discover your Telegram chat id.
//
// Usage:
//   1. Open Telegram and send "/start" (or any message) to your bot
//   2. Set TELEGRAM_BOT_TOKEN in your env
//   3. Run: npx tsx scripts/telegram-bootstrap.ts
//   4. Copy the chat id printed below and set it as TELEGRAM_CHAT_ID
//
// Why this exists: Telegram bots can't initiate conversations. You have
// to message the bot first; then we can read the chat id from getUpdates.
// Once you've set both env vars and restarted PM2, alerts go out
// automatically as signals fire.
//
// This script does NOT touch SQLite or the in-memory caches — it's a
// pure read against the Telegram HTTP API.

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("TELEGRAM_BOT_TOKEN not set in env.");
  console.error("Run: TELEGRAM_BOT_TOKEN=xxx npx tsx scripts/telegram-bootstrap.ts");
  process.exit(1);
}

async function main(): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates`);
  const json = (await res.json()) as
    | { ok: true; result: Array<{ message?: { chat: { id: number; type: string; title?: string; username?: string; first_name?: string } } }> }
    | { ok: false; description: string };

  if (!json.ok) {
    console.error("Telegram API error:", json.description);
    process.exit(1);
  }

  const chats = new Map<number, { type: string; label: string; lastSeen: number }>();
  for (let i = 0; i < json.result.length; i++) {
    const upd = json.result[i];
    if (!upd.message) continue;
    const chat = upd.message.chat;
    const label = chat.title ?? chat.username ?? chat.first_name ?? "(unknown)";
    chats.set(chat.id, { type: chat.type, label, lastSeen: i });
  }

  if (chats.size === 0) {
    console.log("No messages yet. Send /start (or any message) to your bot from Telegram,");
    console.log("then re-run this script. Bots can't initiate conversations.");
    return;
  }

  console.log("Discovered chat ids (most recent last):\n");
  const sorted = [...chats.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen);
  for (const [id, info] of sorted) {
    console.log(`  ${id}  (${info.type}, "${info.label}")`);
  }
  console.log("\nSet the one you want as TELEGRAM_CHAT_ID and restart PM2.");
  console.log("If you want alerts in a group, add the bot to the group first.");
}

main().catch((err) => {
  console.error("bootstrap failed:", err);
  process.exit(1);
});
