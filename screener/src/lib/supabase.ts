import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Feature-flagged Supabase client.
//
// Persistence is optional: if the env vars are absent we return a null
// client and all callers of `getSupabase()` log + skip writes. That keeps
// dev ergonomics simple (you can run the screener without configuring a
// database) while still letting production flip it on via:
//   NEXT_PUBLIC_SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY  (server-side only — bypasses RLS)
//
// We deliberately use the service-role key here because this module is
// only ever imported from API routes and cron jobs that run on the server.
// The anon key would be fine for reads but we need service-role to insert
// signal events without having to configure RLS policies for a system-
// level writer.

let clientSingleton: SupabaseClient | null = null;
let warnedMissing = false;

export function getSupabase(): SupabaseClient | null {
  if (clientSingleton) return clientSingleton;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    // Warn once so it's visible at startup but doesn't flood logs per call.
    if (!warnedMissing) {
      console.warn(
        "[supabase] NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set — " +
          "signal persistence disabled. Set both env vars to enable."
      );
      warnedMissing = true;
    }
    return null;
  }

  clientSingleton = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return clientSingleton;
}

export function isSupabaseEnabled(): boolean {
  return !!(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}
