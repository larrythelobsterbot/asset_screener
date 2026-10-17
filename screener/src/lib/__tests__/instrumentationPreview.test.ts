import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "../../instrumentation";

async function withPreviewEnv(flag: string, check: () => Promise<void>) {
  const keys = ["NEXT_RUNTIME", "NEXT_PHASE", "SCREENER_DISABLE_BACKGROUND", "SCREENER_SELF_ORIGIN"] as const;
  const prior = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.NEXT_RUNTIME = "nodejs";
    delete process.env.NEXT_PHASE;
    process.env.SCREENER_DISABLE_BACKGROUND = flag;
    process.env.SCREENER_SELF_ORIGIN = "https://invalid-preview-origin.example";
    await check();
  } finally {
    for (const key of keys) {
      if (prior[key] === undefined) delete process.env[key];
      else process.env[key] = prior[key];
    }
  }
}

test("explicit isolated-preview flag prevents every instrumentation bootstrap", async () => {
  await withPreviewEnv("1", async () => {
    await assert.doesNotReject(register());
  });
});

test("background disable requires the exact opt-in value", async () => {
  await withPreviewEnv("true", async () => {
    await assert.rejects(register(), /loopback/);
  });
});
