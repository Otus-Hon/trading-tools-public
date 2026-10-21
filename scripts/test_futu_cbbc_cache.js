#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const {
  hasCompleteCbbc,
  mergeVerifiedCbbcPayload,
  selectDetailCbbcLevels,
} = require("../lib/futuCbbc");

const levels = [
  { side: "bear", price: 24000, streetVolume: 30 },
  { side: "bear", price: 24100, streetVolume: 20 },
  { side: "bull", price: 23000, streetVolume: 40 },
  { side: "bull", price: 22900, streetVolume: 10 },
];
const complete = {
  ok: true,
  cbbcLevels: levels,
  cbbcTotal: 4,
  cbbcActive: 4,
  cbbcRowsFetched: 4,
  cbbcComplete: true,
  cbbcFetchedAt: "2026-10-21T14:00:00+08:00",
};
const liveOnly = { ok: true, snapshots: { "HK.800000": { price: 23500 } }, cbbcLevels: [], cbbcTotal: 0, cbbcRowsFetched: 0, cbbcComplete: false };

assert.equal(hasCompleteCbbc(complete), true);
assert.equal(hasCompleteCbbc({ ...complete, cbbcRowsFetched: 3 }), false);
const merged = mergeVerifiedCbbcPayload(liveOnly, complete);
assert.equal(merged.cbbcComplete, true);
assert.deepStrictEqual(merged.cbbcLevels, levels);
assert.deepStrictEqual(
  selectDetailCbbcLevels(merged, 23500, 1).map((level) => `${level.side}:${level.price}`),
  ["bear:24000", "bull:23000"]
);
assert.deepStrictEqual(selectDetailCbbcLevels({ ...complete, cbbcComplete: false }, 23500), []);
console.log("Futu CBBC cache and detail-selection tests passed");
