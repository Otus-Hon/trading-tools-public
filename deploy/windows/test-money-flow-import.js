const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const Database = require("better-sqlite3");

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "money-flow-import-"));
const dataDir = path.join(tempRoot, "data");
const backupDir = path.join(tempRoot, "backups");
const targetPath = path.join(dataDir, "market.sqlite");
const seedPath = path.join(tempRoot, "seed.sqlite");
fs.mkdirSync(dataDir, { recursive: true });

const schema = `
  CREATE TABLE money_flow_long (
    date TEXT PRIMARY KEY, weekday_zh TEXT, money_flow_million REAL NOT NULL,
    underlying_last REAL NOT NULL, underlying_pct_change REAL NOT NULL,
    fetched_at_utc TEXT NOT NULL, source_url TEXT
  );
  CREATE TABLE money_flow_short (
    date TEXT PRIMARY KEY, weekday_zh TEXT, money_flow_million REAL NOT NULL,
    underlying_last REAL NOT NULL, underlying_pct_change REAL NOT NULL,
    fetched_at_utc TEXT NOT NULL, source_url TEXT
  );
`;
const row = (date, value) => [date, "一", value, 25000, 0.5, "2026-10-21T00:00:00.000Z", "https://www.citicswarrants.com/test"];
const target = new Database(targetPath);
target.exec(schema);
target.prepare("INSERT INTO money_flow_long VALUES (?, ?, ?, ?, ?, ?, ?)").run(...row("2026-10-20", 999));
target.close();
const seed = new Database(seedPath);
seed.exec(schema);
for (const [table, values] of Object.entries({
  money_flow_long: [row("2026-10-19", 10), row("2026-10-20", 20)],
  money_flow_short: [row("2026-10-19", -10), row("2026-10-20", -20)],
})) {
  const insert = seed.prepare(`INSERT INTO ${table} VALUES (?, ?, ?, ?, ?, ?, ?)`);
  for (const value of values) insert.run(...value);
}
seed.close();

try {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const run = spawnSync(process.execPath, [path.join(__dirname, "import-money-flow.js"), seedPath], {
      encoding: "utf8",
      env: { ...process.env, TRADING_TOOLS_DATA_DIR: dataDir, TRADING_TOOLS_BACKUP_DIR: backupDir },
    });
    assert.strictEqual(run.status, 0, run.stderr);
  }
  const check = new Database(targetPath, { readonly: true });
  assert.strictEqual(check.prepare("SELECT COUNT(*) AS count FROM money_flow_long").get().count, 2);
  assert.strictEqual(check.prepare("SELECT COUNT(*) AS count FROM money_flow_short").get().count, 2);
  assert.strictEqual(check.prepare("SELECT money_flow_million AS value FROM money_flow_long WHERE date = '2026-10-20'").get().value, 999);
  assert.strictEqual(check.prepare("SELECT COUNT(*) AS count FROM money_flow_imports").get().count, 1);
  assert.strictEqual(check.pragma("integrity_check", { simple: true }), "ok");
  check.close();
  const floor = JSON.parse(fs.readFileSync(path.join(dataDir, "money-flow-history-floor.json"), "utf8"));
  assert.deepStrictEqual(floor.long, { minimum_rows: 2, min_date: "2026-10-19", max_date: "2026-10-20" });
  assert.deepStrictEqual(floor.short, { minimum_rows: 2, min_date: "2026-10-19", max_date: "2026-10-20" });
  assert.ok(fs.readdirSync(backupDir).filter((name) => name.endsWith(".sqlite")).length >= 2);
  console.log("money-flow private seed import tests passed");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
