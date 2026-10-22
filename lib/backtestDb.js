/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { dataPath } = require("./dataPaths");

const DB_PATH = process.env.BACKTEST_DB_PATH || dataPath("backtest.sqlite");
let instance;

function getBacktestDb() {
  if (!instance) {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    instance = new Database(DB_PATH);
    instance.pragma("journal_mode = WAL");
    instance.pragma("synchronous = NORMAL");
    instance.exec(`
      CREATE TABLE IF NOT EXISTS candles (
        symbol TEXT NOT NULL,
        timeframe TEXT NOT NULL,
        time INTEGER NOT NULL,
        time_key TEXT NOT NULL,
        open REAL NOT NULL,
        high REAL NOT NULL,
        low REAL NOT NULL,
        close REAL NOT NULL,
        volume REAL NOT NULL DEFAULT 0,
        turnover REAL,
        source TEXT NOT NULL DEFAULT 'futu',
        fetched_at_utc TEXT NOT NULL,
        PRIMARY KEY (symbol, timeframe, time)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_candles_time_key
        ON candles(symbol, timeframe, time_key);
      CREATE INDEX IF NOT EXISTS idx_candles_range
        ON candles(symbol, timeframe, time);
      CREATE TABLE IF NOT EXISTS candle_sync_log (
        timeframe TEXT NOT NULL,
        range_start TEXT NOT NULL,
        range_end TEXT NOT NULL,
        row_count INTEGER NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        fetched_at_utc TEXT NOT NULL,
        PRIMARY KEY (timeframe, range_start, range_end)
      );
    `);
  }
  return instance;
}

function readCandles(timeframe, start, end) {
  const db = getBacktestDb();
  return db.prepare(`
    SELECT time, time_key AS timeKey, open, high, low, close, volume, turnover
    FROM candles
    WHERE symbol = 'HK.HSImain' AND timeframe = ?
      AND time_key >= ? AND time_key < ?
    ORDER BY time ASC
  `).all(timeframe, `${start} 00:00:00`, `${end} 23:59:59.999`);
}

function upsertCandles(timeframe, bars, source = "futu") {
  const db = getBacktestDb();
  const fetchedAt = new Date().toISOString();
  const insert = db.prepare(`
    INSERT INTO candles(symbol, timeframe, time, time_key, open, high, low, close, volume, turnover, source, fetched_at_utc)
    VALUES ('HK.HSImain', @timeframe, @time, @timeKey, @open, @high, @low, @close, @volume, @turnover, @source, @fetchedAt)
    ON CONFLICT(symbol, timeframe, time) DO UPDATE SET
      time_key=excluded.time_key, open=excluded.open, high=excluded.high,
      low=excluded.low, close=excluded.close, volume=excluded.volume,
      turnover=excluded.turnover, source=excluded.source, fetched_at_utc=excluded.fetched_at_utc
  `);
  const transaction = db.transaction((items) => {
    for (const bar of items) {
      insert.run({
        timeframe, time: Number(bar.time), timeKey: String(bar.timeKey),
        open: Number(bar.open), high: Number(bar.high), low: Number(bar.low), close: Number(bar.close),
        volume: Number(bar.volume || 0), turnover: Number.isFinite(Number(bar.turnover)) ? Number(bar.turnover) : null,
        source, fetchedAt,
      });
    }
  });
  transaction(Array.isArray(bars) ? bars : []);
}

function coverage(timeframe) {
  return getBacktestDb().prepare(`
    SELECT COUNT(*) AS count, MIN(time_key) AS first, MAX(time_key) AS last,
           COUNT(DISTINCT substr(time_key, 1, 10)) AS tradingDays
    FROM candles WHERE symbol = 'HK.HSImain' AND timeframe = ?
  `).get(timeframe);
}

function latestBar(timeframe) {
  return getBacktestDb().prepare(`
    SELECT time, time_key AS timeKey, open, high, low, close, volume, turnover, fetched_at_utc AS fetchedAtUtc
    FROM candles
    WHERE symbol = 'HK.HSImain' AND timeframe = ?
    ORDER BY time DESC
    LIMIT 1
  `).get(timeframe) || null;
}

function earliestBar(timeframe) {
  return getBacktestDb().prepare(`
    SELECT time, time_key AS timeKey, open, high, low, close, volume, turnover, fetched_at_utc AS fetchedAtUtc
    FROM candles
    WHERE symbol = 'HK.HSImain' AND timeframe = ?
    ORDER BY time ASC
    LIMIT 1
  `).get(timeframe) || null;
}

function listTradingDays(timeframe, limit) {
  return getBacktestDb().prepare(`
    SELECT DISTINCT substr(time_key, 1, 10) AS day
    FROM candles
    WHERE symbol = 'HK.HSImain' AND timeframe = ?
    ORDER BY day DESC
    LIMIT ?
  `).all(timeframe, Number(limit) || 30).map((row) => row.day);
}

function listSessionDays(timeframe, limit, beforeDate) {
  const limitN = Math.min(250, Math.max(1, Number(limit) || 15));
  const before = beforeDate || "9999-12-31";
  if (timeframe === "1d") {
    return getBacktestDb().prepare(`
      SELECT DISTINCT substr(time_key, 1, 10) AS day
      FROM candles
      WHERE symbol = 'HK.HSImain' AND timeframe = ? AND substr(time_key, 1, 10) <= ?
      ORDER BY day DESC
      LIMIT ?
    `).all(timeframe, before, limitN).map((row) => row.day);
  }
  return getBacktestDb().prepare(`
    SELECT DISTINCT substr(time_key, 1, 10) AS day
    FROM candles
    WHERE symbol = 'HK.HSImain' AND timeframe = ?
      AND substr(time_key, 1, 10) <= ?
      AND (
        (substr(time_key, 12, 5) >= '09:16' AND substr(time_key, 12, 5) <= '12:00')
        OR (substr(time_key, 12, 5) >= '13:01' AND substr(time_key, 12, 5) <= '16:30')
      )
    ORDER BY day DESC
    LIMIT ?
  `).all(timeframe, before, limitN).map((row) => row.day);
}

function logSync(timeframe, rangeStart, rangeEnd, rowCount, status, error) {
  getBacktestDb().prepare(`
    INSERT INTO candle_sync_log(timeframe, range_start, range_end, row_count, status, error, fetched_at_utc)
    VALUES (@timeframe, @rangeStart, @rangeEnd, @rowCount, @status, @error, @fetchedAt)
    ON CONFLICT(timeframe, range_start, range_end) DO UPDATE SET
      row_count=excluded.row_count, status=excluded.status, error=excluded.error, fetched_at_utc=excluded.fetched_at_utc
  `).run({
    timeframe,
    rangeStart,
    rangeEnd,
    rowCount: Number(rowCount || 0),
    status,
    error: error || null,
    fetchedAt: new Date().toISOString(),
  });
}

module.exports = { DB_PATH, getBacktestDb, readCandles, upsertCandles, coverage, earliestBar, latestBar, listTradingDays, listSessionDays, logSync };
