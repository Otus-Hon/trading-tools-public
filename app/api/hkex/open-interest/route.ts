import fs from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import marketDbModule from "../../../../lib/marketDb.js";
import dataPathsModule from "../../../../lib/dataPaths.js";
import publicModeModule from "../../../../lib/publicMode.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Row = {
  date: string;
  value: number;
  change: number | null;
  source?: string;
  fetched_at_utc?: string;
};

const { dataPath } = dataPathsModule as unknown as { dataPath: (...segments: string[]) => string };
const { isPublicMode } = publicModeModule as unknown as { isPublicMode: () => boolean };
const CACHE_PATH = dataPath("hkex_hsi_open_interest.json");
const FUTU_CACHE_PATH = dataPath("futu_open_interest.json");
const LOOKBACK_DAYS = 240;
const HKEX_SOURCE = "HKEX HSI Futures Daily Market Reports";
const FUTU_SOURCE = "Futu HK.HSImain snapshot";
let historyRefreshInFlight: Promise<{ rows: Row[]; meta: Record<string, unknown> | null }> | null = null;

const marketDb = marketDbModule as unknown as {
  upsertOpenInterest: (rows: Row[], source: string, fetchedAt?: string) => void;
  readOpenInterest: () => { rows: Row[]; meta: Record<string, unknown> | null };
  deleteOpenInterestBySourceThrough: (source: string, throughDate: string) => number;
};

function readCache(filePath = CACHE_PATH): Row[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveCache(rows: Row[]) {
  fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
  fs.writeFileSync(
    CACHE_PATH,
    JSON.stringify(rows.filter((row) => row.source === HKEX_SOURCE))
  );
}

function isoDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function reportCode(date: Date) {
  return isoDate(date).replace(/^20/, "").replaceAll("-", "");
}

function latestExpectedReportDate(now = new Date()) {
  // HKEX's completed daily report is for the previous Hong Kong trading day.
  // Compare against that date explicitly: an age-based cache check considered
  // Friday "fresh" on Monday/Tuesday and therefore skipped Monday's report.
  const hongKongNow = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Hong_Kong" }));
  const expected = new Date(Date.UTC(
    hongKongNow.getFullYear(),
    hongKongNow.getMonth(),
    hongKongNow.getDate() - 1
  ));
  while (expected.getUTCDay() === 0 || expected.getUTCDay() === 6) {
    expected.setUTCDate(expected.getUTCDate() - 1);
  }
  return isoDate(expected);
}

async function fetchReport(date: Date): Promise<Row | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7_000);
  try {
    const response = await fetch(
      `https://www.hkex.com.hk/eng/stat/dmstat/dayrpt/hsif${reportCode(date)}.htm`,
      { cache: "no-store", signal: controller.signal, headers: { "User-Agent": "Mozilla/5.0" } }
    );
    if (!response.ok) return null;
    const html = await response.text();
    const match = html.match(/All Contracts Total\s+([\d,]+)\s+([\d,]+)\s+([+-]?[\d,]+)/i);
    if (!match) return null;
    const value = Number(match[2].replaceAll(",", ""));
    const change = Number(match[3].replaceAll(",", ""));
    if (!Number.isFinite(value) || value <= 0) return null;
    return { date: isoDate(date), value, change: Number.isFinite(change) ? change : null };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function refreshHistory(existing: Row[]) {
  const authoritativeDates = new Set(
    existing.filter((row) => row.source === HKEX_SOURCE).map((row) => row.date)
  );
  const candidates: Date[] = [];
  const today = new Date();
  for (let offset = 1; offset <= LOOKBACK_DAYS; offset += 1) {
    const date = new Date(today);
    date.setUTCDate(today.getUTCDate() - offset);
    const day = date.getUTCDay();
    if (day === 0 || day === 6 || authoritativeDates.has(isoDate(date))) continue;
    candidates.push(date);
  }
  const fetched: Row[] = [];
  for (let index = 0; index < candidates.length; index += 12) {
    const rows = await Promise.all(candidates.slice(index, index + 12).map(fetchReport));
    rows.forEach((row) => { if (row) fetched.push(row); });
  }
  return fetched.sort((a, b) => a.date.localeCompare(b.date));
}

export async function GET(request: NextRequest) {
  const fetchedAt = new Date().toISOString();

  // One-time-compatible migration: preserve every row already accumulated in
  // the legacy JSON files before SQL becomes the only read source.
  let stored = marketDb.readOpenInterest();
  const storedByDate = new Map(stored.rows.map((row) => [row.date, row]));
  // Reapply cached HKEX rows when a prior Futu refresh contaminated that date.
  // Source-aware upserts make this idempotent and prevent the reverse overwrite.
  const legacyHkex = readCache(CACHE_PATH).filter(
    (row) => storedByDate.get(row.date)?.source !== HKEX_SOURCE
  );
  legacyHkex.forEach((row) => storedByDate.set(row.date, { ...row, source: HKEX_SOURCE }));
  const latestAuthoritativeDate = Array.from(storedByDate.values())
    .filter((row) => row.source === HKEX_SOURCE)
    .map((row) => row.date)
    .sort()
    .at(-1);
  const legacyFutu = readCache(FUTU_CACHE_PATH).filter(
    (row) => !storedByDate.has(row.date) && (!latestAuthoritativeDate || row.date > latestAuthoritativeDate)
  );
  if (legacyHkex.length > 0) {
    marketDb.upsertOpenInterest(legacyHkex, HKEX_SOURCE, fetchedAt);
  }
  if (legacyFutu.length > 0) {
    marketDb.upsertOpenInterest(legacyFutu, FUTU_SOURCE, fetchedAt);
  }
  if (legacyHkex.length > 0 || legacyFutu.length > 0) {
    stored = marketDb.readOpenInterest();
  }

  // Keep only the current, not-yet-official Futu observation. Weekend and
  // historical HSImain rows are a different aggregation and must not remain
  // inside the authoritative HKEX history range.
  const latestOfficialDate = stored.rows
    .filter((row) => row.source === HKEX_SOURCE)
    .at(-1)?.date;
  if (latestOfficialDate && marketDb.deleteOpenInterestBySourceThrough(FUTU_SOURCE, latestOfficialDate) > 0) {
    stored = marketDb.readOpenInterest();
  }

  const latest = stored.rows
    .filter((row) => row.source === HKEX_SOURCE)
    .at(-1)?.date;
  const today = new Date().toISOString().slice(0, 10);
  const expectedLatest = latestExpectedReportDate();
  const isFresh = Boolean(latest && latest >= expectedLatest);
  const forceRefresh = !isPublicMode() && request.nextUrl.searchParams.get("refresh") === "1";

  if (forceRefresh || !isFresh || stored.rows.length < 60) {
    if (!historyRefreshInFlight) {
      const startingRows = stored.rows;
      historyRefreshInFlight = refreshHistory(startingRows)
        .then((refreshedRows) => {
          if (refreshedRows.length > 0) {
            marketDb.upsertOpenInterest(refreshedRows, HKEX_SOURCE, fetchedAt);
          }
          const completed = marketDb.readOpenInterest();
          saveCache(completed.rows);
          return completed;
        })
        .finally(() => { historyRefreshInFlight = null; });
    }
    stored = await historyRefreshInFlight;
  }

  const rows = stored.rows;
  return NextResponse.json({
    ok: true,
    rows,
    rowCount: rows.length,
    storage: "market.sqlite",
    source: HKEX_SOURCE,
    liveSource: FUTU_SOURCE,
    fetchedAt,
    asOf: rows.at(-1)?.date ?? today,
    expectedAsOf: expectedLatest,
  }, {
    headers: { "Cache-Control": "no-store" },
  });
}
