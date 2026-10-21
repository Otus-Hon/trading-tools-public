// Fetch HSI CBBC data, write JSON mirrors, and upsert the market DB.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { refreshCbbcSnapshot, getSnapshotFreshness } = require("../lib/cbbcSnapshot");

async function main() {
  try {
    const payload = await refreshCbbcSnapshot();
    const freshness = getSnapshotFreshness(payload, 0);
    const exampleBear = payload.bearRows[0] ? JSON.stringify(payload.bearRows[0]) : "null";
    const exampleBull = payload.bullRows[0] ? JSON.stringify(payload.bullRows[0]) : "null";

    console.log(
      `OK: bear=${payload.bearRows.length} bull=${payload.bullRows.length} exampleBear=${exampleBear} exampleBull=${exampleBull}`
    );
    console.log(`source: ${payload.source_url}`);
    console.log(`meta.stime returned: ${payload.meta?.stime ?? "n/a"}`);
    console.log(`outstandingDate: ${freshness.outstandingDate ?? "n/a"}`);
    console.log(`fetched_at_utc: ${payload.fetched_at_utc}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const snippet = err && typeof err === "object" ? err.snippet : null;
    console.error(`Error fetching CBBC: ${message}`);
    if (snippet) console.error(`body-snippet=${snippet}`);
    process.exit(1);
  }
}

main();
