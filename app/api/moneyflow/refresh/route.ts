import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import marketDbModule from "../../../../lib/marketDb.js";
import dataPathsModule from "../../../../lib/dataPaths.js";

export const runtime = "nodejs";

const { dataPath } = dataPathsModule as unknown as { dataPath: (...segments: string[]) => string };
const LONG_DATA_PATH = dataPath("mirrors", "money_flow_long.json");
const SHORT_DATA_PATH = dataPath("mirrors", "money_flow_short.json");
const TIMEOUT_MS = 10_000;
// CITIC publishes a rolling daily series, not a tick feed. The UI may reread the
// verified SQLite history every five seconds, but provider refetches are throttled
// to avoid rate limits and stale/error fallbacks.
const COOLDOWN_MS = 5 * 60_000;

let lastCompletedAt = 0;
let refreshInFlight: Promise<RefreshResult> | null = null;

const marketDb = marketDbModule as unknown as {
  upsertMoneyFlowLong: (payload: unknown) => void;
  upsertMoneyFlowShort: (payload: unknown) => void;
  readMoneyFlowLong: () => { rows: ParsedRow[]; meta: Record<string, unknown> };
  readMoneyFlowShort: () => { rows: ParsedRow[]; meta: Record<string, unknown> };
};

const buildLongUrl = () =>
  `https://www.citicswarrants.com/tc/ajax/money-flow-history/underlying/HSI/mtype/long/day/month?_=${Date.now()}`;
const buildShortUrl = () =>
  `https://www.citicswarrants.com/tc/ajax/money-flow-history/underlying/HSI/mtype/short/day/month?_=${Date.now()}`;

function parseNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/<[^>]+>/g, "").replace(/,/g, "").trim();
  if (!cleaned) return null;
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
}

function parsePct(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/<[^>]+>/g, "").replace("%", "").trim();
  if (!cleaned) return null;
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
}

type RawRow = {
  tradeday?: unknown;
  weekday?: unknown;
  mflow?: unknown;
  last?: unknown;
  pchng?: unknown;
};

type ParsedRow = {
  date: string;
  weekday_zh: string;
  money_flow_million: number;
  underlying_last: number;
  underlying_pct_change: number;
};

type RefreshResult = {
  fetchedAt: string;
  longFetchedRows: number;
  shortFetchedRows: number;
  longStoredRows: number;
  shortStoredRows: number;
  longLatestDate: string | null;
  shortLatestDate: string | null;
};

function parseRow(row: RawRow): ParsedRow | null {
  const date = (row?.tradeday || "").toString().trim();
  const weekday = (row?.weekday || "").toString().trim();
  const moneyFlow = parseNumber(row?.mflow);
  const last = parseNumber(row?.last);
  const pct = parsePct(row?.pchng);

  if (!date || moneyFlow === null || last === null || pct === null) return null;

  return {
    date,
    weekday_zh: weekday,
    money_flow_million: moneyFlow,
    underlying_last: last,
    underlying_pct_change: pct,
  };
}

async function fetchWithTimeout(url: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    return res;
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

function ensureDir(filePath: string) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

function writeJson(filePath: string, content: unknown) {
  ensureDir(filePath);
  fs.writeFileSync(filePath, JSON.stringify(content, null, 2), {
    encoding: "utf8",
    flag: "w",
  });
}

async function fetchAndParse(url: string, series: "long" | "short") {
  const fetchedAt = new Date().toISOString();
  const res = await fetchWithTimeout(url);
  const bodyText = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${bodyText.slice(0, 200)}`);
  let json: {
    result?: RawRow[];
    sname?: unknown;
    stime?: unknown;
    total_mflow?: unknown;
  };
  try {
    json = JSON.parse(bodyText);
  } catch {
    throw new Error(`JSON parse error: ${bodyText.slice(0, 200)}`);
  }

  const rawRows: RawRow[] = Array.isArray(json.result) ? json.result : [];
  const rows = rawRows.map(parseRow).filter((row): row is ParsedRow => row !== null);

  return {
    payload: {
      fetched_at_utc: fetchedAt,
      source_url: url,
      meta: {
        sname: json.sname ?? null,
        stime: json.stime ?? null,
        total_mflow_raw: json.total_mflow ?? null,
        unit_money_flow: "million",
        unit_underlying_price: "points",
        series,
      },
      rows,
    },
    count: rows.length,
  };
}

function storedResult(refreshed: boolean, reason?: string) {
  const storedLong = marketDb.readMoneyFlowLong();
  const storedShort = marketDb.readMoneyFlowShort();
  return {
    ok: true,
    refreshed,
    reason: reason ?? null,
    fetched_at_utc:
      storedLong.meta?.fetched_at_utc ?? storedShort.meta?.fetched_at_utc ?? null,
    long_rows: storedLong.rows.length,
    short_rows: storedShort.rows.length,
    long_stored_rows: storedLong.rows.length,
    short_stored_rows: storedShort.rows.length,
    long_latest_date: storedLong.rows.at(-1)?.date ?? null,
    short_latest_date: storedShort.rows.at(-1)?.date ?? null,
    database_updated: refreshed,
    storage: "market.sqlite",
  };
}

async function runRefresh(): Promise<RefreshResult> {
  const [longResult, shortResult] = await Promise.all([
    fetchAndParse(buildLongUrl(), "long"),
    fetchAndParse(buildShortUrl(), "short"),
  ]);

  // SQLite is the source of truth. Upsert the provider's latest rolling window
  // first, then read the complete accumulated history back from SQL for both
  // the API response metadata and inspection mirrors.
  marketDb.upsertMoneyFlowLong(longResult.payload);
  marketDb.upsertMoneyFlowShort(shortResult.payload);
  const storedLong = marketDb.readMoneyFlowLong();
  const storedShort = marketDb.readMoneyFlowShort();
  const longMirror = { ...longResult.payload, meta: storedLong.meta, rows: storedLong.rows };
  const shortMirror = { ...shortResult.payload, meta: storedShort.meta, rows: storedShort.rows };
  writeJson(LONG_DATA_PATH, longMirror);
  writeJson(SHORT_DATA_PATH, shortMirror);

  return {
    fetchedAt: longResult.payload.fetched_at_utc,
    longFetchedRows: longResult.count,
    shortFetchedRows: shortResult.count,
    longStoredRows: storedLong.rows.length,
    shortStoredRows: storedShort.rows.length,
    longLatestDate: storedLong.rows.at(-1)?.date ?? null,
    shortLatestDate: storedShort.rows.at(-1)?.date ?? null,
  };
}

export async function POST() {
  const now = Date.now();
  if (now - lastCompletedAt < COOLDOWN_MS && !refreshInFlight) {
    return NextResponse.json(storedResult(false, "cooldown"), {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    });
  }

  try {
    const joinedExistingRefresh = refreshInFlight !== null;
    if (!refreshInFlight) {
      refreshInFlight = runRefresh().finally(() => {
        lastCompletedAt = Date.now();
        refreshInFlight = null;
      });
    }
    const result = await refreshInFlight;

    return NextResponse.json(
      {
        ok: true,
        refreshed: !joinedExistingRefresh,
        joined_in_flight: joinedExistingRefresh,
        fetched_at_utc: result.fetchedAt,
        long_rows: result.longFetchedRows,
        short_rows: result.shortFetchedRows,
        database_updated: true,
        long_stored_rows: result.longStoredRows,
        short_stored_rows: result.shortStoredRows,
        long_latest_date: result.longLatestDate,
        short_latest_date: result.shortLatestDate,
        storage: "market.sqlite",
      },
      { status: 200, headers: { "Cache-Control": "no-store" } }
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const stored = storedResult(false, "provider-error");
    if (stored.long_stored_rows > 0 && stored.short_stored_rows > 0) {
      return NextResponse.json(
        { ...stored, provider_error: message || "Request failed" },
        { status: 200, headers: { "Cache-Control": "no-store" } }
      );
    }
    return NextResponse.json(
      { ok: false, error: message || "Request failed" },
      { status: 502, headers: { "Cache-Control": "no-store" } }
    );
  }
}
