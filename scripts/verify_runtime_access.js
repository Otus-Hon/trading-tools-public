#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */

const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");

const dataDir = process.env.TRADING_TOOLS_DATA_DIR;
if (!dataDir || !path.isAbsolute(dataDir)) {
  throw new Error("TRADING_TOOLS_DATA_DIR must be an absolute private-data path.");
}

fs.mkdirSync(dataDir, { recursive: true });
const databasePath = path.join(dataDir, ".deployment-sqlite-check.sqlite");
let database;
try {
  database = new Database(databasePath);
  database.exec("CREATE TABLE IF NOT EXISTS deployment_check (value INTEGER NOT NULL)");
  database.exec("DELETE FROM deployment_check; INSERT INTO deployment_check (value) VALUES (1)");
  const row = database.prepare("SELECT value FROM deployment_check").get();
  if (row?.value !== 1) throw new Error("SQLite write/read verification returned an unexpected value.");
  console.log(`[runtime] SQLite ${Database.name} loaded under Node ${process.version} (ABI ${process.versions.modules}).`);
  console.log("[runtime] Service account can write and read the private data directory.");
} finally {
  if (database) database.close();
  for (const suffix of ["", "-shm", "-wal"]) {
    fs.rmSync(`${databasePath}${suffix}`, { force: true, maxRetries: 5, retryDelay: 100 });
  }
}
