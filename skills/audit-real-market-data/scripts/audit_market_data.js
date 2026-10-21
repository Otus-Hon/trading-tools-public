#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */

const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");
const {
  MONEY_FLOW_LONG_SEED,
  MONEY_FLOW_SHORT_SEED,
} = require("../../../lib/moneyFlowSeed");

const root = path.resolve(__dirname, "../../..");
const dataDir = path.resolve(process.env.TRADING_TOOLS_DATA_DIR || path.join(root, "private-data", "runtime"));
const dbPath = process.env.MARKET_DB_PATH || path.join(dataDir, "market.sqlite");
const futuCachePath = path.join(dataDir, "futu_market_data_cache.json");
const jsonMode = process.argv.includes("--json");
const findings = [];

function add(level, code, message, evidence = null) {
  findings.push({ level, code, message, evidence });
}

function hkNowParts() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Hong_Kong",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function hkDate() {
  const p = hkNowParts();
  return `${p.year}-${p.month}-${p.day}`;
}

function parseHkt(raw) {
  const match = String(raw || "").match(
    /(\d{4})[-/](\d{2})[-/](\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/
  );
  if (!match) return null;
  return Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]) - 8,
    Number(match[5]),
    Number(match[6] || 0)
  );
}

function dayGap(left, right) {
  return Math.round(
    (Date.parse(`${right}T00:00:00Z`) - Date.parse(`${left}T00:00:00Z`)) / 86_400_000
  );
}

if (!fs.existsSync(dbPath)) {
  add("ERROR", "DB_MISSING", `${dbPath} does not exist.`);
} else {
  const db = new Database(dbPath, { readonly: true });

  const oi = db.prepare(`
    SELECT date, value, change, source, fetched_at_utc
    FROM hsi_open_interest
    ORDER BY date
  `).all();
  const official = oi.filter((row) => row.source === "HKEX HSI Futures Daily Market Reports");
  const futu = oi.filter((row) => row.source === "Futu HK.HSImain snapshot");
  if (official.length < 60) {
    add("ERROR", "OI_HISTORY_SHORT", "Official HKEX open-interest history has fewer than 60 rows.", official.length);
  }
  const latestOfficial = official.at(-1);
  const staleFutu = futu.filter((row) => latestOfficial && row.date <= latestOfficial.date);
  if (staleFutu.length) {
    add("ERROR", "OI_SOURCE_CONFLICT", "Futu rows exist on or before the latest authoritative HKEX date.", staleFutu);
  }
  for (let index = 1; index < official.length; index += 1) {
    const previous = official[index - 1];
    const current = official[index];
    const gap = dayGap(previous.date, current.date);
    const comparable = gap === 1 || (gap === 3 && new Date(`${previous.date}T00:00:00Z`).getUTCDay() === 5);
    if (comparable && Math.abs((current.value - previous.value) - current.change) > 0.001) {
      add("ERROR", "OI_CHANGE_MISMATCH", `HKEX OI change does not reconcile on ${current.date}.`, {
        previous: previous.value,
        value: current.value,
        reportedChange: current.change,
        computedChange: current.value - previous.value,
      });
    }
  }
  add("INFO", "OI_SUMMARY", "Open-interest source summary.", {
    officialRows: official.length,
    latestOfficial,
    futuRows: futu.length,
    latestFutu: futu.at(-1) || null,
  });

  const long = db.prepare(`
    SELECT date, money_flow_million, underlying_last, fetched_at_utc
    FROM money_flow_long ORDER BY date
  `).all();
  const short = db.prepare(`
    SELECT date, money_flow_million, underlying_last, fetched_at_utc
    FROM money_flow_short ORDER BY date
  `).all();
  if (!long.length || !short.length) {
    add("ERROR", "MONEY_FLOW_MISSING", "Long and short money-flow histories are both required.");
  } else {
    const latestLong = long.at(-1);
    const latestShort = short.at(-1);
    if (latestLong.date !== latestShort.date) {
      add("ERROR", "MONEY_FLOW_DATE_MISMATCH", "Long and short latest dates differ.", {
        long: latestLong.date,
        short: latestShort.date,
      });
    }
    if (latestLong.date === latestShort.date && latestLong.underlying_last !== latestShort.underlying_last) {
      add("ERROR", "MONEY_FLOW_UNDERLYING_MISMATCH", "Long and short rows disagree on the HSI level.", {
        long: latestLong.underlying_last,
        short: latestShort.underlying_last,
      });
    }
    add("INFO", "MONEY_FLOW_SUMMARY", "Money-flow source summary.", {
      longRows: long.length,
      shortRows: short.length,
      latestDate: latestLong.date,
      fetchedAt: latestLong.fetched_at_utc,
    });
  }
  const longDates = new Set(long.map((row) => row.date));
  const shortDates = new Set(short.map((row) => row.date));
  const missingLongSeedDates = MONEY_FLOW_LONG_SEED
    .map((row) => row[0])
    .filter((date) => !longDates.has(date));
  const missingShortSeedDates = MONEY_FLOW_SHORT_SEED
    .map((row) => row[0])
    .filter((date) => !shortDates.has(date));
  if (missingLongSeedDates.length || missingShortSeedDates.length) {
    add("ERROR", "MONEY_FLOW_SEED_MISSING", "SQLite is missing versioned money-flow baseline dates.", {
      long: missingLongSeedDates,
      short: missingShortSeedDates,
    });
  } else {
    add("INFO", "MONEY_FLOW_SEED_SUMMARY", "Versioned money-flow baseline is present in SQLite.", {
      longRows: MONEY_FLOW_LONG_SEED.length,
      longRange: [MONEY_FLOW_LONG_SEED[0][0], MONEY_FLOW_LONG_SEED.at(-1)[0]],
      shortRows: MONEY_FLOW_SHORT_SEED.length,
      shortRange: [MONEY_FLOW_SHORT_SEED[0][0], MONEY_FLOW_SHORT_SEED.at(-1)[0]],
    });
  }

  const cbbc = db.prepare(`
    SELECT fetched_at_utc, sdate, stime, ulast, hsilast
    FROM cbbc_meta ORDER BY fetched_at_utc DESC LIMIT 1
  `).get();
  if (!cbbc) {
    add("ERROR", "CBBC_MISSING", "No persisted CBBC snapshot exists.");
  } else {
    const sourceDate = String(cbbc.stime || "").slice(0, 10);
    if (sourceDate && sourceDate < hkDate()) {
      add("WARN", "CBBC_PUBLICATION_OLD", "Latest J.P. Morgan CBBC publication date is before today.", cbbc);
    }
    add("INFO", "CBBC_SUMMARY", "CBBC publication and outstanding dates are distinct.", cbbc);
  }
  db.close();
}

if (!fs.existsSync(futuCachePath)) {
  add("ERROR", "FUTU_CACHE_MISSING", "No verified Futu market-data cache exists.");
} else {
  try {
    const cache = JSON.parse(fs.readFileSync(futuCachePath, "utf8"));
    const payload = cache?.payload || {};
    const cash = payload?.snapshots?.["HK.800000"];
    const futures = payload?.snapshots?.["HK.HSImain"];
    if (!payload.ok || !cash || !futures) {
      add("ERROR", "FUTU_CACHE_INVALID", "Futu cache lacks a verified cash/futures snapshot.");
    } else {
      const cashEpoch = parseHkt(cash.updateTime);
      const ageSeconds = cashEpoch === null ? null : (Date.now() - cashEpoch) / 1000;
      if (ageSeconds === null) {
        add("ERROR", "FUTU_TIME_INVALID", "Futu cash timestamp cannot be parsed.", cash.updateTime);
      } else if (ageSeconds > 120) {
        add("WARN", "FUTU_CACHE_STALE", "Futu cache is not a live tick.", { updateTime: cash.updateTime, ageSeconds });
      }
      const latestCandle = Array.isArray(payload.candles) ? payload.candles.at(-1) : null;
      if (latestCandle?.date === String(cash.updateTime).slice(0, 10)) {
        for (const field of ["open", "high", "low", "close"]) {
          if (!Number.isFinite(Number(latestCandle[field])) || Number(latestCandle[field]) <= 0) {
            add("ERROR", "FUTU_CANDLE_INVALID", `Latest Futu candle has invalid ${field}.`, latestCandle);
          }
        }
      }
      for (const code of ["HK.00700", "HK.09988", "HK.00005"]) {
        const quote = payload?.snapshots?.[code];
        if (
          !quote
          || !Number.isFinite(Number(quote.price))
          || Number(quote.price) <= 0
          || !Number.isFinite(Number(quote.lastClose))
          || Number(quote.lastClose) <= 0
          || !Number.isFinite(Number(quote.changePercent))
          || parseHkt(quote.updateTime) === null
        ) {
          add("ERROR", "FUTU_RIGHT_PANEL_INVALID", `${code} lacks a provider price, previous close, percent change, or timestamp.`, quote || null);
        }
      }
      const cbbcLevels = Array.isArray(payload.cbbcLevels) ? payload.cbbcLevels : [];
      const cbbcTotal = Number(payload.cbbcTotal);
      const cbbcRowsFetched = Number(payload.cbbcRowsFetched);
      if (
        payload.cbbcComplete !== true
        || !Number.isInteger(cbbcTotal)
        || cbbcTotal <= 0
        || cbbcRowsFetched !== cbbcTotal
        || cbbcLevels.length === 0
      ) {
        add(
          "ERROR",
          "FUTU_CBBC_INCOMPLETE",
          "Futu CBBC recovery levels were not aggregated from the complete active product universe.",
          { cbbcComplete: payload.cbbcComplete, cbbcRowsFetched, cbbcTotal, levels: cbbcLevels.length }
        );
      } else {
        add("INFO", "FUTU_CBBC_SUMMARY", "Complete Futu CBBC universe summary.", {
          products: cbbcRowsFetched,
          levels: cbbcLevels.length,
          fetchedAt: payload.cbbcFetchedAt,
        });
      }
      const contract = payload.futuresContract;
      const expiryMonth = String(contract?.expiryDate || "").slice(2, 7).replace("-", "");
      const contractMonth = String(contract?.contractCode || "").slice(-4);
      if (
        !contract
        || contract.continuousCode !== "HK.HSImain"
        || !/^HK\.HSI\d{4}$/.test(String(contract.contractCode || ""))
        || !/^\d{4}-\d{2}-\d{2}$/.test(String(contract.expiryDate || ""))
        || contract.source !== "Futu get_future_info"
        || contract.selectionPolicy !== "front_calendar_month_until_expiry_date_end_hkt"
        || contractMonth !== expiryMonth
      ) {
        add(
          "ERROR",
          "FUTU_EXPIRY_INVALID",
          "Futu cache lacks valid front-calendar-month expiry metadata or selection policy.",
          contract || null
        );
      } else {
        const daysToExpiry = dayGap(hkDate(), contract.expiryDate);
        if (daysToExpiry < 0) {
          add(
            "ERROR",
            "FUTU_EXPIRY_PAST",
            "The cached front-calendar-contract expiry is before the current Hong Kong date.",
            { hkDate: hkDate(), daysToExpiry, contract }
          );
        }
        add("INFO", "FUTU_EXPIRY_SUMMARY", "Exact Futu front-calendar-month expiry summary.", {
          hkDate: hkDate(),
          daysToExpiry,
          contract,
        });
      }
      add("INFO", "FUTU_SUMMARY", "Futu symbol and live snapshot summary.", {
        priceSymbol: payload.priceSymbol,
        volumeSymbol: payload.volumeSymbol,
        cash,
        futures,
        fetchedAt: payload.fetchedAt,
      });
    }
  } catch (error) {
    add("ERROR", "FUTU_CACHE_PARSE", "Futu cache is not valid JSON.", String(error));
  }
}

const backtestPath = process.env.BACKTEST_DB_PATH || path.join(dataDir, "backtest.sqlite");
if (!fs.existsSync(backtestPath)) {
  add("WARN", "BACKTEST_DB_MISSING", `${backtestPath} does not exist yet; backtest history has not been stored.`);
} else {
  const backtestDb = new Database(backtestPath, { readonly: true });
  const today = hkDate();
  let lastClosed = today;
  {
    const previous = new Date(`${today}T00:00:00Z`);
    previous.setUTCDate(previous.getUTCDate() - 1);
    lastClosed = previous.toISOString().slice(0, 10);
    let weekday = new Date(`${lastClosed}T00:00:00Z`).getUTCDay();
    while (weekday === 0 || weekday === 6) {
      const step = new Date(`${lastClosed}T00:00:00Z`);
      step.setUTCDate(step.getUTCDate() - 1);
      lastClosed = step.toISOString().slice(0, 10);
      weekday = new Date(`${lastClosed}T00:00:00Z`).getUTCDay();
    }
  }
  const timeframes = ["1m", "15m", "4h", "1d"];
  const summary = {};
  for (const timeframe of timeframes) {
    const row = backtestDb.prepare(`
      SELECT COUNT(*) AS count, MIN(time_key) AS first, MAX(time_key) AS last
      FROM candles WHERE symbol = 'HK.HSImain' AND timeframe = ?
    `).get(timeframe);
    summary[timeframe] = row;
    if (!row?.count) {
      add("ERROR", "BACKTEST_TF_EMPTY", `Backtest ${timeframe} history has no stored HK.HSImain candles.`);
      continue;
    }
    const lastDate = String(row.last || "").slice(0, 10);
    const grace = timeframe === "4h" ? 3 : 0;
    const threshold = new Date(Date.parse(`${lastClosed}T00:00:00Z`) - grace * 86_400_000).toISOString().slice(0, 10);
    if (lastDate < threshold) {
      add("WARN", "BACKTEST_STALE", `Backtest ${timeframe} last bar ${row.last} is behind last closed HKT session ${lastClosed}.`, row);
    }
  }
  add("INFO", "BACKTEST_SUMMARY", "Backtest SQLite HK.HSImain coverage.", summary);
}

const errors = findings.filter((finding) => finding.level === "ERROR");
const warnings = findings.filter((finding) => finding.level === "WARN");
const report = {
  ok: errors.length === 0,
  auditedAt: new Date().toISOString(),
  hkDate: hkDate(),
  errors: errors.length,
  warnings: warnings.length,
  findings,
};

if (jsonMode) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  for (const finding of findings) {
    const suffix = finding.evidence === null ? "" : ` ${JSON.stringify(finding.evidence)}`;
    process.stdout.write(`[${finding.level}] ${finding.code}: ${finding.message}${suffix}\n`);
  }
  process.stdout.write(`Result: ${report.ok ? "PASS" : "FAIL"} (${errors.length} errors, ${warnings.length} warnings)\n`);
}

process.exitCode = errors.length ? 1 : 0;
