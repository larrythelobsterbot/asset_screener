// Side-effect-only module: sets SCREENER_DB_PATH to a per-process tmpfile
// BEFORE db.ts is evaluated. Imported as `import "./db-test-setup";` at
// the top of db.test.ts so its body runs before the DAL singleton boots.

import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tmp = mkdtempSync(join(tmpdir(), "screener-db-"));
process.env.SCREENER_DB_PATH = join(tmp, "test.db");
// Never allow unit tests that import the alerter to contact a real Telegram
// destination inherited from the developer or PM2 environment.
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_CHAT_ID;
