// Fetch CITIC HSI money flow (bullish/long and bearish/short) and emit normalized JSON for the dashboard.
// Output files (written atomically):
//   private-data/runtime/mirrors/money_flow.json - ignored local mirror
//
// Normalized shape:
// {
//   fetched_at_utc: string,
//   source: {
//     provider: "citicswarrants",
//     underlying: "HSI",
//     range: "month",
//     unit_money_flow: "million",
//     unit_underlying_price: "points",
//     urls: { bullish_long_url, bearish_short_url }
//   },
//   meta: {
//     stime_bullish,
//     stime_bearish,
//     total_mflow_bullish_raw,
//     total_mflow_bearish_raw
//   },
//   bullish: [...],
//   bearish: [...],
//   errors: [...]
// }

const fs = require("fs");
const path = require("path");
const { dataPath } = require("../lib/dataPaths");

const DATA_PATH = dataPath("mirrors", "money_flow.json");
const TIMEOUT_MS = 10_000;

const buildUrls = () => {
  const now = Date.now();
  return {
    bullish: `https://www.citicswarrants.com/tc/ajax/money-flow-history/underlying/HSI/mtype/long/day/month?_=${now}`,
    bearish: `https://www.citicswarrants.com/tc/ajax/money-flow-history/underlying/HSI/mtype/short/day/month?_=${now}`,
  };
};

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise
      .then((val) => {
        clearTimeout(t);
        resolve(val);
      })
      .catch((err) => {
        clearTimeout(t);
        reject(err);
      });
  });
}

function parseNumber(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw === "string") {
    const cleaned = raw.replace(/<[^>]+>/g, "").replace(/,/g, "").replace(/\s+/g, "").trim();
    if (!cleaned) return null;
    const num = Number(cleaned);
    return Number.isFinite(num) ? num : null;
  }
  return null;
}

function parsePct(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw === "string") {
    const cleaned = raw.replace(/<[^>]+>/g, "").replace("%", "").replace(/\s+/g, "").trim();
    if (!cleaned) return null;
    const num = Number(cleaned);
    return Number.isFinite(num) ? num : null;
  }
  return null;
}

function parseRow(row) {
  const date = (row?.date || row?.sdate || row?.day || "").toString().trim();
  const weekday = (row?.weekday || row?.week || row?.weekday_zh || row?.wk || "").toString().trim();
  const moneyFlow = parseNumber(row?.mflow ?? row?.money_flow ?? row?.moneyflow ?? row?.mflow_span);
  const last = parseNumber(row?.last ?? row?.underlying_last ?? row?.lastprice);
  const pct = parsePct(row?.pchng ?? row?.pct_change ?? row?.pchange ?? row?.percent);

  if (!date || moneyFlow === null || last === null || pct === null) {
    console.warn("Skipping row with missing required fields:", row);
    return null;
  }

  return {
    date,
    weekday_zh: weekday || "",
    money_flow_million: moneyFlow,
    underlying_last: last,
    underlying_pct_change: pct,
  };
}

async function fetchJson(url, label) {
  let res;
  try {
    res = await withTimeout(fetch(url), TIMEOUT_MS, label);
  } catch (err) {
    throw new Error(`${label} request failed: ${err.message}`);
  }

  if (!res.ok) {
    const snippet = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(`${label} HTTP ${res.status} ${snippet}`);
  }

  try {
    return await res.json();
  } catch (err) {
    throw new Error(`${label} JSON parse error: ${err.message}`);
  }
}

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

function writeAtomic(filePath, content) {
  ensureDir(filePath);
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, content, { encoding: "utf8" });
  fs.renameSync(tmpPath, filePath);
}

async function main() {
  const urls = buildUrls();
  const fetchedAt = new Date().toISOString();
  const errors = [];

  let bullishData = { stime: null, total_mflow: null, rows: [] };
  let bearishData = { stime: null, total_mflow: null, rows: [] };

  try {
    const data = await fetchJson(urls.bullish, "bullish");
    const rows = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
    bullishData = {
      stime: data?.stime ?? null,
      total_mflow: data?.total_mflow ?? null,
      rows: rows
        .map((r) => parseRow(r))
        .filter((r) => r !== null),
    };
  } catch (err) {
    errors.push(`bullish fetch failed: ${err.message}`);
  }

  try {
    const data = await fetchJson(urls.bearish, "bearish");
    const rows = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
    bearishData = {
      stime: data?.stime ?? null,
      total_mflow: data?.total_mflow ?? null,
      rows: rows
        .map((r) => parseRow(r))
        .filter((r) => r !== null),
    };
  } catch (err) {
    errors.push(`bearish fetch failed: ${err.message}`);
  }

  const payload = {
    fetched_at_utc: fetchedAt,
    source: {
      provider: "citicswarrants",
      underlying: "HSI",
      range: "month",
      unit_money_flow: "million",
      unit_underlying_price: "points",
      urls: {
        bullish_long_url: urls.bullish,
        bearish_short_url: urls.bearish,
      },
    },
    meta: {
      stime_bullish: bullishData.stime ?? null,
      stime_bearish: bearishData.stime ?? null,
      total_mflow_bullish_raw: bullishData.total_mflow ?? null,
      total_mflow_bearish_raw: bearishData.total_mflow ?? null,
    },
    bullish: bullishData.rows,
    bearish: bearishData.rows,
    errors,
  };

  const json = JSON.stringify(payload, null, 2);
  writeAtomic(DATA_PATH, json);

  console.log(
    `OK: bullish rows=${bullishData.rows.length} bearish rows=${bearishData.rows.length} errors=${errors.length}`
  );
  console.log(`Wrote data:   ${DATA_PATH}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
