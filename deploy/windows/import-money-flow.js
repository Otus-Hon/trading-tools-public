const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { DATA_DIR, dataPath } = require("../../lib/dataPaths");

const seedPath = path.resolve(process.argv[2] || "");
const targetPath = path.resolve(process.env.MARKET_DB_PATH || dataPath("market.sqlite"));
const historyFloorPath = path.join(path.dirname(targetPath), "money-flow-history-floor.json");
const backupDir = path.resolve(
  process.env.TRADING_TOOLS_BACKUP_DIR || path.join(path.dirname(DATA_DIR), "backups")
);

function fail(message) {
  throw new Error(message);
}

function validateRow(row, series) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(row.date || ""))) {
    fail(`${series} seed contains an invalid date.`);
  }
  for (const key of ["money_flow_million", "underlying_last", "underlying_pct_change"]) {
    if (!Number.isFinite(Number(row[key]))) fail(`${series} ${row.date} has invalid ${key}.`);
  }
  if (Number(row.underlying_last) <= 0) fail(`${series} ${row.date} has an invalid HSI level.`);
  if (row.source_url) {
    const source = new URL(row.source_url);
    if (source.protocol !== "https:" || source.hostname !== "www.citicswarrants.com") {
      fail(`${series} ${row.date} has an unexpected provider URL.`);
    }
  }
}

function readSeedRows(seed, table, series) {
  const rows = seed.prepare(`
    SELECT date, weekday_zh, money_flow_million, underlying_last,
           underlying_pct_change, fetched_at_utc, source_url
    FROM ${table}
    ORDER BY date ASC
  `).all();
  if (rows.length === 0) fail(`${series} seed contains no rows.`);
  const dates = new Set();
  for (const row of rows) {
    validateRow(row, series);
    if (dates.has(row.date)) fail(`${series} seed contains duplicate date ${row.date}.`);
    dates.add(row.date);
  }
  return rows;
}

async function main() {
  if (!seedPath || !fs.existsSync(seedPath)) fail("Money-flow seed file does not exist.");
  if (!fs.existsSync(targetPath)) fail(`Target market database does not exist: ${targetPath}`);
  if (seedPath === targetPath) fail("Seed and target database must be different files.");

  const seedHash = crypto.createHash("sha256").update(fs.readFileSync(seedPath)).digest("hex");
  const seed = new Database(seedPath, { readonly: true, fileMustExist: true });
  const target = new Database(targetPath, { fileMustExist: true });
  try {
    if (seed.pragma("integrity_check", { simple: true }) !== "ok") fail("Seed SQLite integrity check failed.");
    if (target.pragma("integrity_check", { simple: true }) !== "ok") fail("Target SQLite integrity check failed.");

    const longRows = readSeedRows(seed, "money_flow_long", "long");
    const shortRows = readSeedRows(seed, "money_flow_short", "short");
    fs.mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:.]/g, "");
    const nonce = crypto.randomBytes(4).toString("hex");
    const backupPath = path.join(backupDir, `market-before-money-flow-${stamp}-${seedHash.slice(0, 8)}-${nonce}.sqlite`);
    await target.backup(backupPath);

    target.exec(`
      CREATE TABLE IF NOT EXISTS money_flow_imports (
        seed_sha256 TEXT PRIMARY KEY,
        imported_at_utc TEXT NOT NULL,
        long_seed_rows INTEGER NOT NULL,
        short_seed_rows INTEGER NOT NULL,
        long_min_date TEXT NOT NULL,
        long_max_date TEXT NOT NULL,
        short_min_date TEXT NOT NULL,
        short_max_date TEXT NOT NULL
      );
    `);
    const insert = (table) => target.prepare(`
      INSERT OR IGNORE INTO ${table} (
        date, weekday_zh, money_flow_million, underlying_last,
        underlying_pct_change, fetched_at_utc, source_url
      ) VALUES (
        @date, @weekday_zh, @money_flow_million, @underlying_last,
        @underlying_pct_change, @fetched_at_utc, @source_url
      )
    `);
    const insertLong = insert("money_flow_long");
    const insertShort = insert("money_flow_short");
    const importRows = target.transaction(() => {
      let insertedLong = 0;
      let insertedShort = 0;
      for (const row of longRows) insertedLong += insertLong.run(row).changes;
      for (const row of shortRows) insertedShort += insertShort.run(row).changes;
      target.prepare(`
        INSERT OR IGNORE INTO money_flow_imports (
          seed_sha256, imported_at_utc, long_seed_rows, short_seed_rows,
          long_min_date, long_max_date, short_min_date, short_max_date
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        seedHash,
        new Date().toISOString(),
        longRows.length,
        shortRows.length,
        longRows[0].date,
        longRows.at(-1).date,
        shortRows[0].date,
        shortRows.at(-1).date
      );
      return { insertedLong, insertedShort };
    });
    const imported = importRows();
    const finalLong = target.prepare("SELECT COUNT(*) AS count, MIN(date) AS min, MAX(date) AS max FROM money_flow_long").get();
    const finalShort = target.prepare("SELECT COUNT(*) AS count, MIN(date) AS min, MAX(date) AS max FROM money_flow_short").get();
    if (target.pragma("integrity_check", { simple: true }) !== "ok") fail("Target integrity check failed after import.");

    const historyFloor = {
      schema_version: 1,
      updated_at_utc: new Date().toISOString(),
      seed_sha256: seedHash,
      long: { minimum_rows: finalLong.count, min_date: finalLong.min, max_date: finalLong.max },
      short: { minimum_rows: finalShort.count, min_date: finalShort.min, max_date: finalShort.max },
    };
    const historyFloorTemp = `${historyFloorPath}.${process.pid}.tmp`;
    fs.writeFileSync(historyFloorTemp, `${JSON.stringify(historyFloor, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(historyFloorTemp, historyFloorPath);

    console.log(JSON.stringify({
      ok: true,
      seed_sha256: seedHash,
      backup_path: backupPath,
      history_floor_path: historyFloorPath,
      seed_long_rows: longRows.length,
      seed_short_rows: shortRows.length,
      inserted_long_rows: imported.insertedLong,
      inserted_short_rows: imported.insertedShort,
      final_long_rows: finalLong.count,
      final_short_rows: finalShort.count,
      long_min_date: finalLong.min,
      long_max_date: finalLong.max,
      short_min_date: finalShort.min,
      short_max_date: finalShort.max,
    }));
  } finally {
    seed.close();
    target.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
