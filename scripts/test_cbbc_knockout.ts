import assert from "node:assert/strict";
import {
  cbbcKnockoutLevel,
  cbbcLevelKnockedOut,
  mergeCbbcLevels,
  newlyKnockedOutLevels,
  normalizeStoredCbbcLevels,
  rowsToCbbcLevels,
} from "../lib/cbbcKnockout.ts";

const bull = cbbcKnockoutLevel("bull", 24900, 24999, 12);
const bear = cbbcKnockoutLevel("bear", 25100, 25199, 8);
assert.ok(bull && bear);

// The chart line is the knockout. Entering the bucket is not enough.
assert.equal(bull.price, 24899);
assert.equal(bull.trigger, 24899);
assert.equal(bear.price, 25200);
assert.equal(bear.trigger, 25200);

assert.equal(cbbcLevelKnockedOut(bull, 25050, 24950), false);
assert.equal(cbbcLevelKnockedOut(bull, 25050, 24899), true);
assert.equal(cbbcLevelKnockedOut(bear, 25199, 24900), false);
assert.equal(cbbcLevelKnockedOut(bear, 25200, 24900), true);

// The 25,200-25,299 bear band (volume 404 on 2026-09-22) is drawn at 25,300.
// A session high of 25,219.61 trades inside the bucket and must stay active.
const band404 = cbbcKnockoutLevel("bear", 25200, 25299, 404);
assert.ok(band404);
assert.equal(band404.price, 25300);
assert.equal(band404.trigger, 25300);
assert.equal(cbbcLevelKnockedOut(band404, 25219.61, 25044.29), false);
assert.equal(cbbcLevelKnockedOut(band404, 25300, 25044.29), true);
const band383 = cbbcKnockoutLevel("bear", 25100, 25199, 383);
assert.ok(band383);
assert.equal(cbbcLevelKnockedOut(band383, 25219.61, 25044.29), true);

// Detail rows are a single recovery price. Trigger and line stay on that price.
const detailBear = cbbcKnockoutLevel("bear", 25099, 25099, 3);
const detailBull = cbbcKnockoutLevel("bull", 24901, 24901, 4);
assert.ok(detailBear && detailBull);
assert.equal(detailBear.trigger, 25100);
assert.equal(detailBear.price, 25100);
assert.equal(detailBull.trigger, 24900);
assert.equal(detailBull.price, 24900);
assert.equal(cbbcLevelKnockedOut(detailBear, 25099, 24950), false);
assert.equal(cbbcLevelKnockedOut(detailBear, 25100, 24950), true);
assert.equal(cbbcLevelKnockedOut(detailBull, 25100, 24901), false);
assert.equal(cbbcLevelKnockedOut(detailBull, 25100, 24900), true);

const open = rowsToCbbcLevels({
  bearRows: [{ start: 25100, end: 25199, count: 8 }, { start: 25200, end: 25299, count: 404 }],
  bullRows: [{ start: 24900, end: 24999, count: 12 }],
});
const { now: baselineNow, newly: baselineNewly } = newlyKnockedOutLevels(open, null, 25020, 24970);
assert.equal(baselineNewly.length, 0);
assert.equal(baselineNow.size, 0);

// The outstanding feed drops the bull band after its line is crossed.
const afterDrop = rowsToCbbcLevels({
  bearRows: [{ start: 25100, end: 25199, count: 8 }],
  bullRows: [],
});
const tracked = mergeCbbcLevels(open, afterDrop);
assert.equal(tracked.length, 3);
const crossed = newlyKnockedOutLevels(tracked, baselineNow, 25020, 24890);
assert.equal(crossed.newly.length, 1);
assert.equal(crossed.newly[0]?.side, "bull");
assert.equal(crossed.newly[0]?.trigger, 24899);

const insideBear = newlyKnockedOutLevels(tracked, crossed.now, 25219.61, 24890);
assert.equal(insideBear.newly.map((level) => level.volume).includes(404), false);
assert.equal(insideBear.newly.length, 1);
assert.equal(insideBear.newly[0]?.trigger, 25200);

const repeat = newlyKnockedOutLevels(tracked, insideBear.now, 25240, 24850);
assert.equal(repeat.newly.length, 0);

// A stored near-edge trigger from the incorrect rule is put back on the line.
const stored = normalizeStoredCbbcLevels([
  { side: "bear", start: 25200, end: 25299, price: 25300, trigger: 25200, volume: 404 },
]);
assert.equal(stored[0]?.trigger, 25300);
assert.equal(stored[0]?.price, 25300);

console.log("cbbc knockout checks passed");
