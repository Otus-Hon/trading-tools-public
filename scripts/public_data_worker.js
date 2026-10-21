#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
const path = require("node:path");
const { spawnPython } = require("../lib/pythonPath");
const futuCache = require("../lib/futuDiskCache");
const { refreshCbbcSnapshot } = require("../lib/cbbcSnapshot");
const { runRefresh: refreshMoneyFlow } = require("../lib/moneyFlowRefresh");
const { refreshOpenInterestIfNeeded } = require("../lib/hkexOpenInterest");
const { refreshBacktestHistories } = require("../lib/backtestRefresh");
const { CHART_SYMBOLS } = require("../lib/requestLimits");
const { dataPath } = require("../lib/dataPaths");
const marketDb = require("../lib/marketDb");

const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const PYTHON_TIMEOUT_MS = 120_000;
const TICK_MS = 1_000;

const jobs = [
  { name: "futu-live", everyMs: 5_000, run: refreshFutuLive },
  { name: "futu-cbbc", everyMs: 5_000, run: refreshFutuCbbc },
  { name: "futu-full", everyMs: 60_000, run: refreshFutuFull },
  { name: "futu-intraday", everyMs: 60_000, run: refreshFutuIntraday },
  { name: "cbbc-bands", everyMs: 15_000, run: refreshCbbcSnapshot },
  { name: "money-flow", everyMs: 5 * 60_000, run: refreshMoneyFlow },
  { name: "hkex-open-interest", everyMs: 15 * 60_000, run: () => refreshOpenInterestIfNeeded(false) },
  { name: "backtest-tail", everyMs: 60 * 60_000, run: () => refreshBacktestHistories(undefined, false) },
  { name: "related-markets", everyMs: 15 * 60_000, run: refreshRelatedMarkets },
].map((job) => ({ ...job, running: false, nextAt: 0 }));

function log(level, message, details) {
  const suffix = details ? ` ${JSON.stringify(details)}` : "";
  process.stdout.write(`[${new Date().toISOString()}] ${level} ${message}${suffix}\n`);
}

function runPythonJson(scriptName, args = []) {
  return new Promise((resolve, reject) => {
    const script = path.join(process.cwd(), "scripts", scriptName);
    const child = spawnPython([script, ...args]);
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(value);
    };

    const append = (target, chunk) => {
      const text = String(chunk);
      outputBytes += Buffer.byteLength(text);
      if (outputBytes > MAX_OUTPUT_BYTES) {
        child.kill("SIGTERM");
        finish(new Error(`${scriptName} exceeded its output limit.`));
        return target;
      }
      return target + text;
    };

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error(`${scriptName} timed out.`));
    }, PYTHON_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    child.on("error", (error) => finish(error));
    child.on("close", () => {
      if (settled) return;
      const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        try {
          const payload = JSON.parse(lines[index]);
          if (!payload?.ok) {
            finish(new Error(typeof payload?.error === "string" ? payload.error : `${scriptName} failed.`));
            return;
          }
          finish(null, payload);
          return;
        } catch {
          // Futu OpenD can write connection messages around the final JSON line.
        }
      }
      finish(new Error(stderr.trim() || `${scriptName} returned no JSON.`));
    });
  });
}

async function fetchJson(url, timeoutMs = 10_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      cache: "no-store",
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchYahooDaily(symbol) {
  const json = await fetchJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5y`);
  const result = json?.chart?.result?.[0];
  const timestamps = Array.isArray(result?.timestamp) ? result.timestamp : [];
  const quote = result?.indicators?.quote?.[0] || {};
  return timestamps.map((timestamp, index) => ({
    time: new Date(Number(timestamp) * 1000).toISOString().slice(0, 10),
    open: Number(quote.open?.[index]),
    high: Number(quote.high?.[index]),
    low: Number(quote.low?.[index]),
    close: Number(quote.close?.[index]),
  })).filter((candle) =>
    /^\d{4}-\d{2}-\d{2}$/.test(candle.time) &&
    [candle.open, candle.high, candle.low, candle.close].every((value) => Number.isFinite(value) && value > 0)
  );
}

async function refreshRelatedMarkets() {
  const prior = futuCache.readJson(dataPath("market_chart_cache.json")) || {};
  const next = { ...prior };
  const quotes = [];
  const labels = {
    "^HSI": "HSI", "USDHKD=X": "USD/HKD", "^DJI": "Dow Jones", "^IXIC": "NASDAQ",
    "^GSPC": "S&P 500", "GC=F": "Gold", "BTC-USD": "BTC/USD", QQQ: "QQQ",
    SQQQ: "SQQQ", "CL=F": "Oil (WTI)",
  };
  const symbols = [...CHART_SYMBOLS];
  const results = await Promise.allSettled(symbols.map(async (symbol) => ({ symbol, candles: await fetchYahooDaily(symbol) })));
  const fetchedAt = Date.now();
  for (const result of results) {
    if (result.status !== "fulfilled" || result.value.candles.length < 2) continue;
    const { symbol, candles } = result.value;
    next[`v2:${symbol}::1d`] = { candles, fetchedAt };
    const current = candles.at(-1)?.close;
    const previous = candles.at(-2)?.close;
    if (labels[symbol] && Number.isFinite(current) && Number.isFinite(previous)) {
      quotes.push({
        symbol,
        label: labels[symbol],
        price: current,
        volume: null,
        change: current - previous,
        changePercent: previous ? ((current - previous) / previous) * 100 : null,
      });
    }
    if (symbol === "^HSI") marketDb.upsertHsiCandles(candles, "yahoo-chart-worker");
  }
  futuCache.writeJson(dataPath("market_chart_cache.json"), next);
  if (quotes.length) marketDb.upsertMarketQuotes(quotes, "yahoo-v8-worker");
  return { charts: results.filter((item) => item.status === "fulfilled").length, quotes: quotes.length };
}

function verifiedCbbcFields(payload) {
  if (
    payload?.cbbcComplete !== true ||
    Number(payload?.cbbcRowsFetched) !== Number(payload?.cbbcTotal) ||
    !Array.isArray(payload?.cbbcLevels)
  ) return null;
  return {
    cbbcLevels: payload.cbbcLevels,
    cbbcTotal: payload.cbbcTotal,
    cbbcActive: payload.cbbcActive,
    cbbcRowsFetched: payload.cbbcRowsFetched,
    cbbcComplete: payload.cbbcComplete,
    cbbcFetchedAt: payload.cbbcFetchedAt,
  };
}

async function refreshFutuLive() {
  const payload = await runPythonJson("futu_market_data.py", ["--skip-cbbc", "--live-only"]);
  const cache = { at: Date.now(), payload };
  futuCache.writeLiveCache(cache);
  futuCache.persistFutuOpenInterest(payload);
  return { source: "HK.800000/HK.HSImain", at: cache.at };
}

async function refreshFutuFull() {
  const payload = await runPythonJson("futu_market_data.py", ["--skip-cbbc"]);
  const existing = futuCache.readFullCache();
  const cbbc = verifiedCbbcFields(existing?.payload);
  const cache = { at: Date.now(), payload: cbbc ? { ...payload, ...cbbc } : payload };
  futuCache.writeFullCache(cache);
  futuCache.persistFutuOpenInterest(payload);
  return { source: "Futu full snapshot", at: cache.at };
}

async function refreshFutuCbbc() {
  const payload = await runPythonJson("futu_market_data.py", ["--cbbc-only"]);
  const cbbc = verifiedCbbcFields(payload);
  if (!cbbc) throw new Error("Futu CBBC pagination was incomplete; cached levels were preserved.");
  const existing = futuCache.readFullCache();
  if (existing?.payload?.ok) {
    futuCache.writeFullCache({ at: existing.at, payload: { ...existing.payload, ...cbbc } });
  }
  return { rows: payload.cbbcRowsFetched, total: payload.cbbcTotal };
}

async function refreshFutuIntraday() {
  const payload = await runPythonJson("futu_hsi_intraday.py");
  if (
    payload?.symbol !== "HK.800000" ||
    payload?.interval !== "15m" ||
    !Array.isArray(payload?.candles) ||
    payload.candles.length < 850
  ) throw new Error("Futu intraday payload failed validation.");
  futuCache.writeJson(futuCache.INTRADAY_CACHE_PATH, { at: Date.now(), payload });
  return { bars: payload.candles.length };
}

async function runDueJobs() {
  const now = Date.now();
  for (const job of jobs) {
    if (job.running || now < job.nextAt) continue;
    job.running = true;
    job.nextAt = now + job.everyMs;
    Promise.resolve()
      .then(job.run)
      .then((result) => log("OK", job.name, result))
      .catch((error) => log("WARN", job.name, { error: error instanceof Error ? error.message : String(error) }))
      .finally(() => { job.running = false; });
  }
}

function shutdown(signal) {
  log("INFO", "worker stopping", { signal });
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("unhandledRejection", (error) => log("ERROR", "unhandled rejection", { error: String(error) }));

if (require.main === module) {
  log("INFO", "public data worker starting", { jobs: jobs.map(({ name, everyMs }) => ({ name, everyMs })) });
  void runDueJobs();
  setInterval(() => { void runDueJobs(); }, TICK_MS);
}

module.exports = { jobs, runPythonJson, verifiedCbbcFields, fetchYahooDaily };
