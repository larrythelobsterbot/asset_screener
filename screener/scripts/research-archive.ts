#!/usr/bin/env node
import { exportArchive, replayArchive, verifyArchive } from "../src/lib/researchArchive";

function usage(): never {
  throw new Error([
    "Usage:",
    "  research-archive.ts export --source db --out NEW_BUNDLE --from ISO --to ISO",
    "  research-archive.ts verify --bundle BUNDLE",
    "  research-archive.ts replay --bundle BUNDLE --out NEW_RESEARCH_DB",
  ].join("\n"));
}
function args(argv: string[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--") || !argv[i + 1] || argv[i + 1].startsWith("--")) usage();
    values[token.slice(2)] = argv[++i];
  }
  return values;
}
function required(values: Record<string, string>, key: string): string {
  if (!values[key]) usage();
  return values[key];
}

async function main(argv: string[]): Promise<void> {
  const command = argv.shift();
  if (!command) usage();
  const values = args(argv);
  if (command === "export") {
    const manifest = await exportArchive({ source: required(values, "source"), out: required(values, "out"), from: required(values, "from"), to: required(values, "to") });
    process.stdout.write(JSON.stringify({ ok: true, format: manifest.format, out: values.out, counts: Object.fromEntries(Object.entries(manifest.datasets).map(([key, value]) => [key, value.count])) }) + "\n");
    return;
  }
  if (command === "verify") {
    const result = await verifyArchive(required(values, "bundle"));
    process.stdout.write(JSON.stringify({ ok: result.ok, format: result.manifest.format, counts: Object.fromEntries(Object.entries(result.manifest.datasets).map(([key, value]) => [key, value.count])) }) + "\n");
    return;
  }
  if (command === "replay") {
    await replayArchive({ bundle: required(values, "bundle"), out: required(values, "out") });
    process.stdout.write(JSON.stringify({ ok: true, out: values.out }) + "\n");
    return;
  }
  usage();
}

main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
