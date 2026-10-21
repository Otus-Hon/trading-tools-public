const fs = require("fs");
const path = require("path");
const marketDb = require("./marketDb");
const { dataPath } = require("./dataPaths");

const LONG_DATA_PATH = dataPath("mirrors", "money_flow_long.json");
const SHORT_DATA_PATH = dataPath("mirrors", "money_flow_short.json");
const TIMEOUT_MS = 10_000;
const COOLDOWN_MS = 5 * 60_000;

let lastCompletedAt = 0;
let refreshInFlight = null;

const buildLongUrl = () =>
  `https://www.citicswarrants.com/tc/ajax/money-flow-history/underlying/HSI/mtype/long/day/month?_=${Date.now()}`;
const buildShortUrl = () =>
  `https://www.citicswarrants.com/tc/ajax/money-flow-history/underlying/HSI/mtype/short/day/month?_=${Date.now()}`;

function parseNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/<[^>]+>/g, "").replace(/,/g, "").trim();
  if (!cleaned) return null;
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
}

function parsePct(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/<[^>]+>/g, "").replace("%", "").trim();
  if (!cleaned) return null;
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
}

function parseRow(row) {
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

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function writeJson(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(content, null, 2), { encoding: "utf8", flag: "w" });
}

async function fetchAndParse(url, series) {
  const fetchedAt = new Date().toISOString();
  const res = await fetchWithTimeout(url);
  const bodyText = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${bodyText.slice(0, 200)}`);
  let json;
  try {
    json = JSON.parse(bodyText);
  } catch {
    throw new Error(`JSON parse error: ${bodyText.slice(0, 200)}`);
  }
  const rawRows = Array.isArray(json.result) ? json.result : [];
  const rows = rawRows.map(parseRow).filter(Boolean);
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

function storedResult(refreshed, reason) {
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

async function runRefresh() {
  const [longResult, shortResult] = await Promise.all([
    fetchAndParse(buildLongUrl(), "long"),
    fetchAndParse(buildShortUrl(), "short"),
  ]);
  marketDb.upsertMoneyFlowLong(longResult.payload);
  marketDb.upsertMoneyFlowShort(shortResult.payload);
  const storedLong = marketDb.readMoneyFlowLong();
  const storedShort = marketDb.readMoneyFlowShort();
  writeJson(LONG_DATA_PATH, { ...longResult.payload, meta: storedLong.meta, rows: storedLong.rows });
  writeJson(SHORT_DATA_PATH, { ...shortResult.payload, meta: storedShort.meta, rows: storedShort.rows });
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

async function refreshMoneyFlowHttp() {
  const now = Date.now();
  if (now - lastCompletedAt < COOLDOWN_MS && !refreshInFlight) {
    return { status: 200, body: storedResult(false, "cooldown") };
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
    return {
      status: 200,
      body: {
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
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stored = storedResult(false, "provider-error");
    if (stored.long_stored_rows > 0 && stored.short_stored_rows > 0) {
      return { status: 200, body: { ...stored, provider_error: message || "Request failed" } };
    }
    return { status: 502, body: { ok: false, error: message || "Request failed" } };
  }
}

module.exports = {
  COOLDOWN_MS,
  runRefresh,
  refreshMoneyFlowHttp,
  storedResult,
};
