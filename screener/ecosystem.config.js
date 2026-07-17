// PM2 process definition.
//
// Why this file exists: when PM2 runs a Node app via `npm start` the
// `pm2 list` / `pm2 info` `version` column reports the *npm* binary's
// version (e.g. 0.39.7), not the app's. Running the Next.js server
// directly via the node_modules binary fixes that so PM2 shows the
// package.json version alongside the process.
//
// We also pin a sensible memory ceiling and give PM2 the cwd explicitly
// so `pm2 start ecosystem.config.js` works from any directory.

module.exports = {
  apps: [
    {
      name: "asset-screener",
      // Executing the next binary directly (instead of `npm start`) lets
      // PM2 introspect the actual package metadata for its version column
      // and avoids the extra npm process in the tree.
      script: "./node_modules/next/dist/bin/next",
      args: "start -p 3003",
      cwd: __dirname,
      env: {
        NODE_ENV: "production",
      },
      max_memory_restart: "512M",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      // Restart policy: auto-restart on crash up to 10 times with
      // exponential back-off, so a transient HL outage doesn't put the
      // app in a restart loop.
      exp_backoff_restart_delay: 1000,
      max_restarts: 10,
    },
    {
      // Standalone leaderboard ingest (smart-money flow, Task 2). Fetches
      // and parses a ~32MB payload — deliberately NOT run inside the
      // asset-screener process, which is capped at 512M (see
      // docs/smart-flow-build-plan.md, ground rule 5). Runs once daily,
      // writes wallet_registry directly via better-sqlite3, then exits;
      // PM2 just starts it back up on the next cron tick, so no
      // autorestart-on-exit and no memory cap needed.
      name: "smart-flow-ingest",
      script: "scripts/ingest-leaderboard.mjs",
      cwd: __dirname,
      autorestart: false,
      cron_restart: "20 0 * * *",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
    },
  ],
};
