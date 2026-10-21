import { NextResponse } from "next/server";

export const runtime = "nodejs";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { readLatestCbbcSnapshot, readTodayCbbcPriceRange } = require("@/lib/marketDb");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { refreshCbbcSnapshot, getSnapshotFreshness, readCbbcSnapshotMirror } = require("@/lib/cbbcSnapshot");

const AUTO_REFRESH_AFTER_MS = 15_000;

export async function GET() {
  let snapshot = readLatestCbbcSnapshot();
  let refreshError: string | null = null;
  let freshPayload: any = null;

  const freshness = getSnapshotFreshness(snapshot, AUTO_REFRESH_AFTER_MS);
  if (!snapshot || !freshness.isFreshFetch) {
    try {
      freshPayload = await refreshCbbcSnapshot();
      snapshot = readLatestCbbcSnapshot();
    } catch (error) {
      refreshError = error instanceof Error ? error.message : String(error);
    }
  }

  if (!snapshot) {
    return NextResponse.json(
      { ok: false, error: refreshError || "No CBBC data available yet." },
      { status: refreshError ? 502 : 404, headers: { "Cache-Control": "no-store" } }
    );
  }

  const { todayHigh, todayLow } = readTodayCbbcPriceRange();
  const mirror = freshPayload || readCbbcSnapshotMirror();
  const responseSnapshot =
    mirror?.fetched_at_utc === snapshot.fetched_at_utc
      ? { ...snapshot, ...mirror }
      : snapshot;
  const latestFreshness = getSnapshotFreshness(responseSnapshot, AUTO_REFRESH_AFTER_MS);

  return NextResponse.json(
    {
      ok: true,
      ...responseSnapshot,
      todayHigh,
      todayLow,
      refreshError,
      freshness: latestFreshness,
    },
    { status: 200, headers: { "Cache-Control": "no-store" } }
  );
}
