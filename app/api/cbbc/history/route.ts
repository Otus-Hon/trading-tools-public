import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

const {
  listCbbcSnapshotDates,
  readCbbcSnapshotByDate,
  readHsiPriceRangeByDate,
// eslint-disable-next-line @typescript-eslint/no-require-imports
} = require("@/lib/marketDb");

function isValidIsoDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export async function GET(request: NextRequest) {
  const date = request.nextUrl.searchParams.get("date");
  const dates = listCbbcSnapshotDates();

  if (!date) {
    return NextResponse.json(
      { ok: true, dates },
      { status: 200, headers: { "Cache-Control": "no-store" } }
    );
  }

  if (!isValidIsoDate(date)) {
    return NextResponse.json(
      { ok: false, error: "Date must use YYYY-MM-DD format." },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }

  const snapshot = readCbbcSnapshotByDate(date);
  if (!snapshot) {
    return NextResponse.json(
      { ok: false, error: `No saved CBBC data is available for ${date}.`, dates },
      { status: 404, headers: { "Cache-Control": "no-store" } }
    );
  }

  const { dayHigh, dayLow, dayClose } = readHsiPriceRangeByDate(date);
  return NextResponse.json(
    {
      ok: true,
      selectedDate: date,
      ...snapshot,
      todayHigh: dayHigh,
      todayLow: dayLow,
      dayClose,
    },
    { status: 200, headers: { "Cache-Control": "no-store" } }
  );
}
