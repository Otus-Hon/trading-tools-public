import { NextRequest, NextResponse } from "next/server";
import publicModeModule from "../../../../lib/publicMode.js";
import hkexModule from "../../../../lib/hkexOpenInterest.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const { isPublicMode } = publicModeModule as unknown as { isPublicMode: () => boolean };
const hkex = hkexModule as unknown as {
  HKEX_SOURCE: string;
  FUTU_SOURCE: string;
  latestExpectedReportDate: () => string;
  refreshOpenInterestIfNeeded: (force?: boolean) => Promise<{ rows: Array<{ date?: string }> }>;
  readStoredOpenInterest: () => { rows: Array<{ date?: string }> };
};

export async function GET(request: NextRequest) {
  const fetchedAt = new Date().toISOString();
  const expectedLatest = hkex.latestExpectedReportDate();
  const today = new Date().toISOString().slice(0, 10);
  const stored = isPublicMode()
    ? hkex.readStoredOpenInterest()
    : await hkex.refreshOpenInterestIfNeeded(!isPublicMode() && request.nextUrl.searchParams.get("refresh") === "1");
  const rows = stored.rows;
  return NextResponse.json({
    ok: true,
    rows,
    rowCount: rows.length,
    storage: "market.sqlite",
    source: hkex.HKEX_SOURCE,
    liveSource: hkex.FUTU_SOURCE,
    fetchedAt,
    asOf: rows.at(-1)?.date ?? today,
    expectedAsOf: expectedLatest,
    cached: isPublicMode(),
  }, {
    headers: { "Cache-Control": "no-store" },
  });
}
