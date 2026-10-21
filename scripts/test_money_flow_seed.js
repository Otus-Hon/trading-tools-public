#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */

process.env.MARKET_DB_PATH = ":memory:";

const assert = require("node:assert/strict");
const marketDb = require("../lib/marketDb");
const {
  MONEY_FLOW_LONG_SEED,
  MONEY_FLOW_SHORT_SEED,
  seedMoneyFlowHistory,
} = require("../lib/moneyFlowSeed");

const db = marketDb.getDb();

const longSummary = db.prepare(
  "SELECT COUNT(*) AS count, MIN(date) AS firstDate, MAX(date) AS lastDate FROM money_flow_long"
).get();
const shortSummary = db.prepare(
  "SELECT COUNT(*) AS count, MIN(date) AS firstDate, MAX(date) AS lastDate FROM money_flow_short"
).get();

assert.deepEqual(longSummary, {
  count: 211,
  firstDate: "2025-12-09",
  lastDate: "2026-10-20",
});
assert.deepEqual(shortSummary, {
  count: 112,
  firstDate: "2026-05-11",
  lastDate: "2026-10-20",
});
assert.equal(MONEY_FLOW_LONG_SEED.length, longSummary.count);
assert.equal(MONEY_FLOW_SHORT_SEED.length, shortSummary.count);

db.prepare("UPDATE money_flow_long SET money_flow_million = 999 WHERE date = '2026-10-20'").run();
assert.deepEqual(seedMoneyFlowHistory(db), { longInserted: 0, shortInserted: 0 });
assert.equal(
  db.prepare("SELECT money_flow_million FROM money_flow_long WHERE date = '2026-10-20'").pluck().get(),
  999,
  "The source seed must never overwrite a later provider update."
);

const mismatchedUnderlying = db.prepare(`
  SELECT l.date
  FROM money_flow_long l
  JOIN money_flow_short s ON s.date = l.date
  WHERE l.underlying_last <> s.underlying_last
     OR l.underlying_pct_change <> s.underlying_pct_change
`).all();
assert.deepEqual(mismatchedUnderlying, []);

db.close();
console.log("money-flow source seed tests passed");
