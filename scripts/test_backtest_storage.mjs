import assert from "node:assert/strict";
import backtestRefresh from "../lib/backtestRefresh.js";

const {
  BACKFILL_CHUNK_DAYS,
  BACKTEST_HISTORY_TARGET_DAYS,
  backfillRangeForCoverage,
} = backtestRefresh;

assert.equal(BACKTEST_HISTORY_TARGET_DAYS, 120);
assert.equal(BACKFILL_CHUNK_DAYS, 30);
assert.deepEqual(
  backfillRangeForCoverage("1m", { tradingDays: 11 }, "2026-10-06 09:15:00"),
  { start: "2026-09-05", end: "2026-10-05" },
);
assert.equal(backfillRangeForCoverage("1m", { tradingDays: 120 }, "2026-05-01 09:15:00"), null);
assert.equal(backfillRangeForCoverage("15m", { tradingDays: 11 }, "2026-10-06 09:15:00"), null);

console.log("backtest SQLite retention/backfill policy passed");
