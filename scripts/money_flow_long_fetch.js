// Fetch CITIC HSI money flow (LONG / mtype=long) and emit a normalized JSON for the dashboard.
// Outputs (atomic writes):
//   private-data/runtime/mirrors/money_flow_long.json - ignored local mirror
//
// Normalized format:
// {
//   fetched_at_utc: string,
//   source_url: string,
//   meta: {
//     sname: string,
//     stime: string,
//     total_mflow_raw: string,
//     unit_money_flow: "million",
//     unit_underlying_price: "points",
//     series: "long"
//   },
//   rows: [
//     { date, weekday_zh, money_flow_million, underlying_last, underlying_pct_change }
//   ]
// }

const fs = require("fs");
const path = require("path");
const { upsertMoneyFlowLong } = require("../lib/marketDb");
const { dataPath } = require("../lib/dataPaths");

const DATA_PATH = dataPath("mirrors", "money_flow_long.json");
const TIMEOUT_MS = 10_000;

const buildUrl = () =>
  `https://www.citicswarrants.com/tc/ajax/money-flow-history/underlying/HSI/mtype/long/day/month?_=${Date.now()}`;

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
    const cleaned = raw.replace(/<[^>]+>/g, "").replace(/,/g, "").trim();
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
    const cleaned = raw.replace(/<[^>]+>/g, "").replace("%", "").trim();
    if (!cleaned) return null;
    const num = Number(cleaned);
    return Number.isFinite(num) ? num : null;
  }
  return null;
}

function parseRow(row) {
  const date = (row?.tradeday || "").toString().trim();
  const weekday = (row?.weekday || "").toString().trim();
  const moneyFlow = parseNumber(row?.mflow);
  const last = parseNumber(row?.last);
  const pct = parsePct(row?.pchng);

  if (!date || moneyFlow === null || last === null || pct === null) {
    console.warn("Skipping row with missing required fields:", row);
    return null;
  }

  return {
    date,
    weekday_zh: weekday,
    money_flow_million: moneyFlow,
    underlying_last: last,
    underlying_pct_change: pct,
  };
}

async function fetchJson(url) {
  let res;
  try {
    res = await withTimeout(fetch(url), TIMEOUT_MS, "money flow request");
  } catch (err) {
    throw new Error(`Request failed: ${err.message}`);
  }

  if (!res.ok) {
    const snippet = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(`HTTP ${res.status} ${snippet}`);
  }

  try {
    return await res.json();
  } catch (err) {
    throw new Error(`JSON parse error: ${err.message}`);
  }
}

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

function writeAtomic(filePath, content) {
  ensureDir(filePath);
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, content, { encoding: "utf8" });
  fs.renameSync(tmp, filePath);
}

async function main() {
  const url = buildUrl();
  const fetchedAt = new Date().toISOString();

  let data;
  try {
    data = await fetchJson(url);
  } catch (err) {
    console.error("Error fetching money flow (long):", err.message);
    process.exit(1);
  }

  const rows = Array.isArray(data?.result) ? data.result : [];
  const parsedRows = rows.map(parseRow).filter((r) => r !== null);

  const payload = {
    fetched_at_utc: fetchedAt,
    source_url: url,
    meta: {
      sname: data?.sname ?? null,
      stime: data?.stime ?? null,
      total_mflow_raw: data?.total_mflow ?? null,
      unit_money_flow: "million",
      unit_underlying_price: "points",
      series: "long",
    },
    rows: parsedRows,
  };

  upsertMoneyFlowLong(payload);

  const json = JSON.stringify(payload, null, 2);
  writeAtomic(DATA_PATH, json);

  console.log(`OK: rows=${parsedRows.length}`);
  console.log(`Wrote data:   ${DATA_PATH}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
