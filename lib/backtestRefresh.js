/* eslint-disable @typescript-eslint/no-require-imports */
const path = require("node:path");
const { coverage, latestBar, logSync, upsertCandles } = require("./backtestDb.js");
const { pythonPath, spawnPython } = require("./pythonPath.js");
const { isPublicMode } = require("./publicMode.js");

const TIMEFRAMES = ["1m", "15m", "4h", "1d"];
const OVERLAP_DAYS = { "1m": 2, "15m": 5, "4h": 10, "1d": 15 };
const EMPTY_LOOKBACK_DAYS = { "1m": 14, "15m": 180, "4h": 365, "1d": 365 };
const AUTO_REFRESH_COOLDOWN_MS = 45_000;
const inFlight = new Map();
const lastAttempt = new Map();

function hkNowParts() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Hong_Kong",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function hkToday() {
  const parts = hkNowParts();
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function shiftDate(date, days) {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

function weekdayIndex(date) {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

function expectedHkSessionDate() {
  const parts = hkNowParts();
  let date = `${parts.year}-${parts.month}-${parts.day}`;
  const hour = Number(parts.hour);
  let weekday = weekdayIndex(date);
  if (hour < 9) date = shiftDate(date, -1);
  weekday = weekdayIndex(date);
  if (weekday === 0) return shiftDate(date, -2);
  if (weekday === 6) return shiftDate(date, -1);
  return date;
}

function lastClosedHkSessionDate(today = hkToday()) {
  let date = shiftDate(today, -1);
  let weekday = weekdayIndex(date);
  while (weekday === 0 || weekday === 6) {
    date = shiftDate(date, -1);
    weekday = weekdayIndex(date);
  }
  return date;
}

function isStale(timeKey, timeframe = "15m") {
  if (!timeKey) return true;
  const last = String(timeKey).slice(0, 10);
  const expected = lastClosedHkSessionDate();
  const graceDays = { "1m": 0, "15m": 0, "4h": 3, "1d": 0 };
  const threshold = shiftDate(expected, -(graceDays[timeframe] || 0));
  return last < threshold;
}

function publicHttpRefreshBlocked() {
  return isPublicMode() && process.env.TRADING_TOOLS_REFRESH_WORKER !== "1";
}

function runBridge(start, end, timeframe) {
  if (publicHttpRefreshBlocked()) {
    return Promise.resolve({ ok: false, error: "OpenD refresh is disabled for public HTTP requests." });
  }
  return new Promise((resolve, reject) => {
    const child = spawnPython([
      path.join(process.cwd(), "scripts", "futu_backtest_15m.py"),
      "--start",
      start,
      "--end",
      end,
      "--timeframe",
      timeframe,
    ]);
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => child.kill("SIGTERM"), 120_000);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", () => {
      clearTimeout(timeout);
      const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        try {
          resolve(JSON.parse(lines[index]));
          return;
        } catch {
          /* OpenD writes logs first. */
        }
      }
      reject(new Error(stderr.trim() || stdout.trim() || "Futu bridge returned no JSON."));
    });
  });
}

async function refreshTimeframe(timeframe, force = false) {
  if (!TIMEFRAMES.includes(timeframe)) {
    return { ok: false, timeframe, error: "Invalid timeframe." };
  }
  const existing = latestBar(timeframe);
  const end = lastClosedHkSessionDate();
  const existingDate = existing?.timeKey ? String(existing.timeKey).slice(0, 10) : null;
  if (!force && existingDate && existingDate >= end) {
    return {
      ok: true,
      timeframe,
      refreshed: false,
      skipped: true,
      stale: false,
      start: existingDate,
      end,
      fetchedCount: 0,
      latest: existing,
      coverage: coverage(timeframe),
      storage: "backtest.sqlite",
      source: "backtest.sqlite",
    };
  }
  const start = existingDate
    ? shiftDate(existingDate, -OVERLAP_DAYS[timeframe])
    : shiftDate(end, -EMPTY_LOOKBACK_DAYS[timeframe]);
  try {
    const payload = await runBridge(start, end, timeframe);
    if (!payload?.ok || !Array.isArray(payload.bars)) {
      const error = payload?.error || payload?.hint || "Futu backtest history failed.";
      logSync(timeframe, start, end, 0, "error", error);
      const latest = latestBar(timeframe);
      return {
        ok: Boolean(latest),
        timeframe,
        refreshed: false,
        stale: true,
        start,
        end,
        fetchedCount: 0,
        error,
        hint: payload?.hint || "Confirm OpenD is connected and futures quote permission is active.",
        latest,
        coverage: coverage(timeframe),
        storage: "backtest.sqlite",
        source: "futu-opend",
      };
    }
    upsertCandles(timeframe, payload.bars, "futu-opend");
    logSync(timeframe, start, end, payload.bars.length, "ok", null);
    const latest = latestBar(timeframe);
    return {
      ok: true,
      timeframe,
      refreshed: true,
        stale: isStale(latest?.timeKey, timeframe),
      start,
      end,
      fetchedCount: payload.bars.length,
      latest,
      coverage: coverage(timeframe),
      storage: "backtest.sqlite",
      source: "futu-opend",
      fetchedAt: new Date().toISOString(),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Futu backtest history failed.";
    logSync(timeframe, start, end, 0, "error", message);
    const latest = latestBar(timeframe);
    return {
      ok: Boolean(latest),
      timeframe,
      refreshed: false,
      stale: true,
      start,
      end,
      fetchedCount: 0,
      error: message,
      latest,
      coverage: coverage(timeframe),
      storage: "backtest.sqlite",
      source: "futu-opend",
    };
  }
}

function refreshTimeframeSingleFlight(timeframe, force = false) {
  if (publicHttpRefreshBlocked()) {
    return Promise.resolve({ ok: false, timeframe, error: "OpenD refresh is disabled for public HTTP requests." });
  }
  const existing = inFlight.get(timeframe);
  if (existing) return existing;
  const previous = lastAttempt.get(timeframe);
  if (!force && previous && Date.now() - previous.at < AUTO_REFRESH_COOLDOWN_MS) {
    return Promise.resolve(previous.result);
  }
  const pending = refreshTimeframe(timeframe, force).then((result) => {
    lastAttempt.set(timeframe, { at: Date.now(), result });
    return result;
  }).finally(() => {
    if (inFlight.get(timeframe) === pending) inFlight.delete(timeframe);
  });
  inFlight.set(timeframe, pending);
  return pending;
}

async function refreshBacktestHistories(timeframes = TIMEFRAMES, force = true) {
  const requested = (Array.isArray(timeframes) && timeframes.length ? timeframes : TIMEFRAMES)
    .filter((item) => TIMEFRAMES.includes(item));
  const unique = [...new Set(requested)];
  const results = [];
  for (const timeframe of unique) {
    results.push(await refreshTimeframeSingleFlight(timeframe, force));
  }
  const errors = results.filter((item) => item.error).map((item) => `${item.timeframe}: ${item.error}`);
  return {
    ok: results.every((item) => item.ok),
    stale: results.some((item) => item.stale),
    hkDate: hkToday(),
    expectedSession: lastClosedHkSessionDate(),
    lastClosedSession: lastClosedHkSessionDate(),
    results,
    errors,
    fetchedAt: new Date().toISOString(),
  };
}

module.exports = {
  TIMEFRAMES,
  expectedHkSessionDate,
  hkToday,
  lastClosedHkSessionDate,
  isStale,
  pythonPath,
  refreshBacktestHistories,
  refreshTimeframeSingleFlight,
  runBridge,
};
