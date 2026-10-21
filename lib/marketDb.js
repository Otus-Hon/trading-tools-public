/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { dataPath } = require("./dataPaths");

// Keep all user/runtime data outside the source tree's public files.
const DB_PATH =
  process.env.MARKET_DB_PATH || dataPath("market.sqlite");
let dbInstance;

function getDb() {
  if (!dbInstance) {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    dbInstance = new Database(DB_PATH);
    dbInstance.pragma("journal_mode = WAL");
    ensureSchema(dbInstance);
  }
  return dbInstance;
}

function ensureSchema(db = getDb()) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS money_flow_long (
      date TEXT PRIMARY KEY,
      weekday_zh TEXT,
      money_flow_million REAL NOT NULL,
      underlying_last REAL NOT NULL,
      underlying_pct_change REAL NOT NULL,
      fetched_at_utc TEXT NOT NULL,
      source_url TEXT
    );

    CREATE TABLE IF NOT EXISTS money_flow_long_meta (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      fetched_at_utc TEXT NOT NULL,
      source_url TEXT,
      sname TEXT,
      stime TEXT,
      total_mflow_raw TEXT,
      series TEXT
    );

    CREATE TABLE IF NOT EXISTS cbbc_meta (
      snapshot_id TEXT PRIMARY KEY,
      fetched_at_utc TEXT NOT NULL,
      source_url TEXT,
      ulast REAL,
      hsilast REAL,
      sdate TEXT,
      stime TEXT,
      sum_bull REAL,
      sum_bear REAL
    );

    CREATE TABLE IF NOT EXISTS cbbc_rows (
      snapshot_id TEXT NOT NULL,
      side TEXT NOT NULL,
      start INTEGER NOT NULL,
      end INTEGER NOT NULL,
      count INTEGER NOT NULL,
      change INTEGER,
      PRIMARY KEY (snapshot_id, side, start, end),
      FOREIGN KEY (snapshot_id) REFERENCES cbbc_meta(snapshot_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_cbbc_meta_fetched ON cbbc_meta(fetched_at_utc DESC);

    CREATE TABLE IF NOT EXISTS market_quotes (
      symbol TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      price REAL,
      volume REAL,
      change REAL,
      change_percent REAL,
      source TEXT,
      fetched_at_utc TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS market_quotes_meta (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      fetched_at_utc TEXT NOT NULL,
      source TEXT
    );

    CREATE TABLE IF NOT EXISTS money_flow_short (
      date TEXT PRIMARY KEY,
      weekday_zh TEXT,
      money_flow_million REAL NOT NULL,
      underlying_last REAL NOT NULL,
      underlying_pct_change REAL NOT NULL,
      fetched_at_utc TEXT NOT NULL,
      source_url TEXT
    );

    CREATE TABLE IF NOT EXISTS money_flow_short_meta (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      fetched_at_utc TEXT NOT NULL,
      source_url TEXT,
      sname TEXT,
      stime TEXT,
      total_mflow_raw TEXT,
      series TEXT
    );

    CREATE TABLE IF NOT EXISTS hsi_open_interest (
      date TEXT PRIMARY KEY,
      value REAL NOT NULL,
      change REAL,
      source TEXT NOT NULL,
      fetched_at_utc TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS hsi_open_interest_meta (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      fetched_at_utc TEXT NOT NULL,
      source TEXT,
      latest_date TEXT
    );

    CREATE TABLE IF NOT EXISTS hsi_candles (
      time TEXT PRIMARY KEY,
      open REAL NOT NULL,
      high REAL NOT NULL,
      low REAL NOT NULL,
      close REAL NOT NULL,
      volume REAL,
      source TEXT,
      fetched_at_utc TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS hsi_candles_meta (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      fetched_at_utc TEXT NOT NULL,
      source TEXT
    );

    CREATE TABLE IF NOT EXISTS market_order (
      symbol TEXT PRIMARY KEY,
      rank INTEGER NOT NULL DEFAULT 0
    );
  `);
}

function upsertMoneyFlowLong(payload) {
  const db = getDb();
  const rows = Array.isArray(payload?.rows) ? payload.rows : [];
  const fetchedAt = payload?.fetched_at_utc || new Date().toISOString();
  const sourceUrl = payload?.source_url || null;
  const meta = payload?.meta || {};

  const insertRow = db.prepare(`
    INSERT INTO money_flow_long (
      date, weekday_zh, money_flow_million, underlying_last, underlying_pct_change, fetched_at_utc, source_url
    )
    VALUES (@date, @weekday_zh, @money_flow_million, @underlying_last, @underlying_pct_change, @fetched_at_utc, @source_url)
    ON CONFLICT(date) DO UPDATE SET
      weekday_zh = excluded.weekday_zh,
      money_flow_million = excluded.money_flow_million,
      underlying_last = excluded.underlying_last,
      underlying_pct_change = excluded.underlying_pct_change,
      fetched_at_utc = excluded.fetched_at_utc,
      source_url = excluded.source_url
  `);

  const tx = db.transaction((items) => {
    for (const row of items) {
      if (!row?.date || !Number.isFinite(Number(row.money_flow_million))) continue;
      insertRow.run({
        date: String(row.date),
        weekday_zh: row.weekday_zh || "",
        money_flow_million: Number(row.money_flow_million),
        underlying_last: Number(row.underlying_last),
        underlying_pct_change: Number(row.underlying_pct_change),
        fetched_at_utc: fetchedAt,
        source_url: sourceUrl,
      });
    }
    db.prepare(
      `INSERT OR REPLACE INTO money_flow_long_meta (id, fetched_at_utc, source_url, sname, stime, total_mflow_raw, series)
       VALUES (1, @fetched_at_utc, @source_url, @sname, @stime, @total_mflow_raw, @series)`
    ).run({
      fetched_at_utc: fetchedAt,
      source_url: sourceUrl,
      sname: meta?.sname ?? null,
      stime: meta?.stime ?? null,
      total_mflow_raw: meta?.total_mflow_raw ?? null,
      series: meta?.series ?? "long",
    });
  });

  tx(rows);
}

function readMoneyFlowLong() {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT date, weekday_zh, money_flow_million, underlying_last, underlying_pct_change, fetched_at_utc, source_url
       FROM money_flow_long
       ORDER BY date ASC`
    )
    .all();
  const meta =
    db
      .prepare(
        `SELECT fetched_at_utc, source_url, sname, stime, total_mflow_raw, series FROM money_flow_long_meta WHERE id = 1`
      )
      .get() || null;
  return { rows, meta };
}

function upsertMoneyFlowShort(payload) {
  const db = getDb();
  const rows = Array.isArray(payload?.rows) ? payload.rows : [];
  const fetchedAt = payload?.fetched_at_utc || new Date().toISOString();
  const sourceUrl = payload?.source_url || null;
  const meta = payload?.meta || {};

  const insertRow = db.prepare(`
    INSERT INTO money_flow_short (
      date, weekday_zh, money_flow_million, underlying_last, underlying_pct_change, fetched_at_utc, source_url
    )
    VALUES (@date, @weekday_zh, @money_flow_million, @underlying_last, @underlying_pct_change, @fetched_at_utc, @source_url)
    ON CONFLICT(date) DO UPDATE SET
      weekday_zh = excluded.weekday_zh,
      money_flow_million = excluded.money_flow_million,
      underlying_last = excluded.underlying_last,
      underlying_pct_change = excluded.underlying_pct_change,
      fetched_at_utc = excluded.fetched_at_utc,
      source_url = excluded.source_url
  `);

  const tx = db.transaction((items) => {
    for (const row of items) {
      if (!row?.date || !Number.isFinite(Number(row.money_flow_million))) continue;
      insertRow.run({
        date: String(row.date),
        weekday_zh: row.weekday_zh || "",
        money_flow_million: Number(row.money_flow_million),
        underlying_last: Number(row.underlying_last),
        underlying_pct_change: Number(row.underlying_pct_change),
        fetched_at_utc: fetchedAt,
        source_url: sourceUrl,
      });
    }
    db.prepare(
      `INSERT OR REPLACE INTO money_flow_short_meta (id, fetched_at_utc, source_url, sname, stime, total_mflow_raw, series)
       VALUES (1, @fetched_at_utc, @source_url, @sname, @stime, @total_mflow_raw, @series)`
    ).run({
      fetched_at_utc: fetchedAt,
      source_url: sourceUrl,
      sname: meta?.sname ?? null,
      stime: meta?.stime ?? null,
      total_mflow_raw: meta?.total_mflow_raw ?? null,
      series: meta?.series ?? "short",
    });
  });

  tx(rows);
}

function readMoneyFlowShort() {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT date, weekday_zh, money_flow_million, underlying_last, underlying_pct_change, fetched_at_utc, source_url
       FROM money_flow_short
       ORDER BY date ASC`
    )
    .all();
  const meta =
    db
      .prepare(
        `SELECT fetched_at_utc, source_url, sname, stime, total_mflow_raw, series FROM money_flow_short_meta WHERE id = 1`
      )
      .get() || null;
  return { rows, meta };
}

function upsertOpenInterest(rows, source = "unknown", fetchedAt = new Date().toISOString()) {
  const db = getDb();
  const items = Array.isArray(rows) ? rows : [];
  const insertRow = db.prepare(`
    INSERT INTO hsi_open_interest (date, value, change, source, fetched_at_utc)
    VALUES (@date, @value, @change, @source, @fetched_at_utc)
    ON CONFLICT(date) DO UPDATE SET
      value = excluded.value,
      change = excluded.change,
      source = excluded.source,
      fetched_at_utc = excluded.fetched_at_utc
    WHERE excluded.source = 'HKEX HSI Futures Daily Market Reports'
       OR hsi_open_interest.source <> 'HKEX HSI Futures Daily Market Reports'
  `);

  const tx = db.transaction((values) => {
    for (const row of values) {
      const date = typeof row?.date === "string" ? row.date.slice(0, 10) : "";
      const value = Number(row?.value);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(value) || value <= 0) continue;
      insertRow.run({
        date,
        value,
        change: Number.isFinite(Number(row?.change)) ? Number(row.change) : null,
        source,
        fetched_at_utc: fetchedAt,
      });
    }
    const latest = db.prepare(`
      SELECT date, source, fetched_at_utc
      FROM hsi_open_interest
      ORDER BY date DESC
      LIMIT 1
    `).get();
    if (latest) {
      db.prepare(`
        INSERT OR REPLACE INTO hsi_open_interest_meta (id, fetched_at_utc, source, latest_date)
        VALUES (1, @fetched_at_utc, @source, @latest_date)
      `).run({
        fetched_at_utc: latest.fetched_at_utc,
        source: latest.source,
        latest_date: latest.date,
      });
    }
  });

  tx(items);
}

function readOpenInterest() {
  const db = getDb();
  const rows = db.prepare(`
    SELECT date, value, change, source, fetched_at_utc
    FROM hsi_open_interest
    ORDER BY date ASC
  `).all();
  const meta = db.prepare(`
    SELECT fetched_at_utc, source, latest_date
    FROM hsi_open_interest_meta
    WHERE id = 1
  `).get() || null;
  return { rows, meta };
}

function deleteOpenInterestBySourceThrough(source, throughDate) {
  const db = getDb();
  if (!source || !/^\d{4}-\d{2}-\d{2}$/.test(String(throughDate || ""))) return 0;
  return db.prepare(`
    DELETE FROM hsi_open_interest
    WHERE source = @source AND date <= @throughDate
  `).run({ source: String(source), throughDate: String(throughDate) }).changes;
}

function upsertCbbcSnapshot(payload) {
  const db = getDb();
  const fetchedAt = payload?.fetched_at_utc || new Date().toISOString();
  const snapshotId = payload?.snapshot_id || fetchedAt;
  const meta = payload?.meta || {};
  const rows = [
    ...(Array.isArray(payload?.bearRows) ? payload.bearRows : []),
    ...(Array.isArray(payload?.bullRows) ? payload.bullRows : []),
  ];

  const insertMeta = db.prepare(
    `INSERT OR REPLACE INTO cbbc_meta (snapshot_id, fetched_at_utc, source_url, ulast, hsilast, sdate, stime, sum_bull, sum_bear)
     VALUES (@snapshot_id, @fetched_at_utc, @source_url, @ulast, @hsilast, @sdate, @stime, @sum_bull, @sum_bear)`
  );
  const insertRow = db.prepare(
    `INSERT OR REPLACE INTO cbbc_rows (snapshot_id, side, start, end, count, change)
     VALUES (@snapshot_id, @side, @start, @end, @count, @change)`
  );

  const tx = db.transaction(() => {
    insertMeta.run({
      snapshot_id: snapshotId,
      fetched_at_utc: fetchedAt,
      source_url: payload?.source_url || null,
      ulast: meta?.ulast ?? null,
      hsilast: meta?.hsilast ?? null,
      sdate: meta?.sdate ?? null,
      stime: meta?.stime ?? null,
      sum_bull: meta?.sumBull ?? meta?.sum_bull ?? null,
      sum_bear: meta?.sumBear ?? meta?.sum_bear ?? null,
    });

    for (const row of rows) {
      if (!row || !row.side || row.end - row.start !== 99) continue;
      insertRow.run({
        snapshot_id: snapshotId,
        side: String(row.side),
        start: Number(row.start),
        end: Number(row.end),
        count: Number(row.count ?? 0),
        change: row.change === null || row.change === undefined ? null : Number(row.change),
      });
    }
  });

  tx();
  return snapshotId;
}

function readLatestCbbcSnapshot() {
  const db = getDb();
  const meta =
    db.prepare(`SELECT * FROM cbbc_meta ORDER BY fetched_at_utc DESC LIMIT 1`).get() || null;
  return readCbbcSnapshotRows(db, meta);
}

function readCbbcSnapshotRows(db, meta) {
  if (!meta) return null;
  const rows = db
    .prepare(
      `SELECT side, start, end, count, change
       FROM cbbc_rows
       WHERE snapshot_id = @snapshot_id
       ORDER BY start DESC`
    )
    .all({ snapshot_id: meta.snapshot_id });
  const bearRows = rows.filter((r) => r.side === "bear");
  const bullRows = rows.filter((r) => r.side === "bull");
  return {
    fetched_at_utc: meta.fetched_at_utc,
    source_url: meta.source_url,
    meta: {
      ulast: meta.ulast,
      hsilast: meta.hsilast,
      sdate: meta.sdate,
      stime: meta.stime,
      sumBull: meta.sum_bull,
      sumBear: meta.sum_bear,
    },
    bearRows,
    bullRows,
  };
}

function readCbbcSnapshotByDate(date) {
  const db = getDb();
  const meta =
    db
      .prepare(
        `SELECT *
         FROM cbbc_meta
         WHERE sdate = @date
         ORDER BY fetched_at_utc DESC
         LIMIT 1`
      )
      .get({ date }) || null;
  return readCbbcSnapshotRows(db, meta);
}

function listCbbcSnapshotDates() {
  const db = getDb();
  return db
    .prepare(
      `SELECT sdate AS date,
              COUNT(*) AS snapshotCount,
              MAX(fetched_at_utc) AS latestFetchedAt
       FROM cbbc_meta
       WHERE sdate IS NOT NULL AND sdate <> ''
       GROUP BY sdate
       ORDER BY sdate DESC`
    )
    .all();
}

function readHsiPriceRangeByDate(date) {
  const db = getDb();
  const row =
    db
      .prepare(
        `SELECT high, low, close
         FROM hsi_candles
         WHERE time = @date
         LIMIT 1`
      )
      .get({ date }) || null;
  return {
    dayHigh: row?.high ?? null,
    dayLow: row?.low ?? null,
    dayClose: row?.close ?? null,
  };
}

function upsertMarketQuotes(quotes, source = "yahoo") {
  const db = getDb();
  const fetchedAt = new Date().toISOString();
  const rows = Array.isArray(quotes) ? quotes : [];
  const insertQuote = db.prepare(
    `INSERT OR REPLACE INTO market_quotes (symbol, label, price, volume, change, change_percent, source, fetched_at_utc)
     VALUES (@symbol, @label, @price, @volume, @change, @change_percent, @source, @fetched_at_utc)`
  );

  const tx = db.transaction((items) => {
    if (items.length > 0) {
      const symbols = items
        .map((row) => (row?.symbol ? String(row.symbol) : null))
        .filter(Boolean);
      if (symbols.length > 0) {
        const placeholders = symbols.map(() => "?").join(", ");
        db.prepare(`DELETE FROM market_quotes WHERE symbol NOT IN (${placeholders})`).run(...symbols);
      }
    }

    for (const row of items) {
      if (!row?.symbol || !row?.label) continue;
      insertQuote.run({
        symbol: String(row.symbol),
        label: String(row.label),
        price: row.price === null || row.price === undefined ? null : Number(row.price),
        volume: row.volume === null || row.volume === undefined ? null : Number(row.volume),
        change: row.change === null || row.change === undefined ? null : Number(row.change),
        change_percent:
          row.changePercent === null || row.changePercent === undefined
            ? null
            : Number(row.changePercent),
        source,
        fetched_at_utc: fetchedAt,
      });
    }

    db.prepare(
      `INSERT OR REPLACE INTO market_quotes_meta (id, fetched_at_utc, source)
       VALUES (1, @fetched_at_utc, @source)`
    ).run({ fetched_at_utc: fetchedAt, source });
  });

  tx(rows);
  return fetchedAt;
}

function readMarketQuotes() {
  const db = getDb();
  const meta =
    db
      .prepare(`SELECT fetched_at_utc, source FROM market_quotes_meta WHERE id = 1`)
      .get() || null;
  const quotes = db
    .prepare(
      `SELECT symbol, label, price, volume, change, change_percent as changePercent, source, fetched_at_utc as fetchedAt
       FROM market_quotes
       ORDER BY label ASC`
    )
    .all();
  return { updatedAt: meta?.fetched_at_utc || null, source: meta?.source || null, quotes };
}

function upsertHsiCandles(candles, source = "unknown") {
  const db = getDb();
  const fetchedAt = new Date().toISOString();
  const rows = Array.isArray(candles) ? candles : [];
  const insertCandle = db.prepare(
    `INSERT OR REPLACE INTO hsi_candles (time, open, high, low, close, volume, source, fetched_at_utc)
     VALUES (@time, @open, @high, @low, @close, @volume, @source, @fetched_at_utc)`
  );

  const tx = db.transaction((items) => {
    if (items.length > 0) {
      const times = items
        .map((row) => (row?.time ? String(row.time) : null))
        .filter(Boolean);
      if (times.length > 0) {
        const placeholders = times.map(() => "?").join(", ");
        db.prepare(`DELETE FROM hsi_candles WHERE time NOT IN (${placeholders})`).run(...times);
      }
    }

    for (const row of items) {
      if (!row?.time) continue;
      insertCandle.run({
        time: String(row.time),
        open: Number(row.open),
        high: Number(row.high),
        low: Number(row.low),
        close: Number(row.close),
        volume: row.volume === null || row.volume === undefined ? null : Number(row.volume),
        source,
        fetched_at_utc: fetchedAt,
      });
    }

    db.prepare(
      `INSERT OR REPLACE INTO hsi_candles_meta (id, fetched_at_utc, source)
       VALUES (1, @fetched_at_utc, @source)`
    ).run({ fetched_at_utc: fetchedAt, source });
  });

  tx(rows);
  return fetchedAt;
}

function readHsiCandles() {
  const db = getDb();
  const meta =
    db
      .prepare(`SELECT fetched_at_utc, source FROM hsi_candles_meta WHERE id = 1`)
      .get() || null;
  const candles = db
    .prepare(
      `SELECT time, open, high, low, close, volume, source, fetched_at_utc as fetchedAt
       FROM hsi_candles
       ORDER BY time ASC`
    )
    .all();
  return { updatedAt: meta?.fetched_at_utc || null, source: meta?.source || null, candles };
}

function readTodayCbbcPriceRange() {
  const db = getDb();
  // Use HK time (UTC+8) to determine today's date boundary
  const nowHk = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const todayHk = nowHk.toISOString().slice(0, 10); // "YYYY-MM-DD"
  const startUtc = new Date(todayHk + "T00:00:00+08:00").toISOString();
  const endUtc = new Date(todayHk + "T23:59:59+08:00").toISOString();

  const row = db
    .prepare(
      `SELECT MAX(CAST(ulast AS REAL)) as todayHigh, MIN(CAST(ulast AS REAL)) as todayLow
       FROM cbbc_meta
       WHERE fetched_at_utc >= @startUtc AND fetched_at_utc <= @endUtc
         AND ulast IS NOT NULL AND CAST(ulast AS REAL) > 0`
    )
    .get({ startUtc, endUtc });

  return {
    todayHigh: row?.todayHigh ?? null,
    todayLow: row?.todayLow ?? null,
  };
}

function saveMarketOrder(symbols) {
  const db = getDb();
  const stmt = db.prepare(`INSERT OR REPLACE INTO market_order (symbol, rank) VALUES (?, ?)`);
  const run = db.transaction((items) => {
    items.forEach((sym, idx) => stmt.run(sym, idx));
  });
  run(symbols);
}

function readMarketOrder() {
  const db = getDb();
  const rows = db.prepare(`SELECT symbol FROM market_order ORDER BY rank ASC`).all();
  return rows.map((r) => r.symbol);
}

module.exports = {
  DB_PATH,
  getDb,
  ensureSchema,
  upsertMoneyFlowLong,
  readMoneyFlowLong,
  upsertCbbcSnapshot,
  readLatestCbbcSnapshot,
  readCbbcSnapshotByDate,
  listCbbcSnapshotDates,
  readHsiPriceRangeByDate,
  upsertMarketQuotes,
  readMarketQuotes,
  upsertHsiCandles,
  readHsiCandles,
  readTodayCbbcPriceRange,
  upsertMoneyFlowShort,
  readMoneyFlowShort,
  upsertOpenInterest,
  readOpenInterest,
  deleteOpenInterestBySourceThrough,
  saveMarketOrder,
  readMarketOrder,
};
