/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("node:fs");
const path = require("node:path");
const { dataPath } = require("./dataPaths");
const marketDb = require("./marketDb");

const FULL_CACHE_PATH = dataPath("futu_market_data_cache.json");
const LIVE_CACHE_PATH = dataPath("futu_market_data_live_cache.json");
const INTRADAY_CACHE_PATH = dataPath("futu_hsi_intraday.json");
const HSI_LIVE_CACHE_PATH = dataPath("hsi_live_cache.json");
const EXPIRY_SELECTION_POLICY = "front_calendar_month_until_expiry_date_end_hkt";

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(value));
  fs.renameSync(tempPath, filePath);
}

function normalizeFullCache(saved) {
  if (!saved?.payload?.ok) return null;
  const contract = saved.payload.futuresContract;
  const payload = contract?.selectionPolicy === EXPIRY_SELECTION_POLICY
    ? saved.payload
    : { ...saved.payload, futuresContract: null };
  return { at: Number(saved.at) || 0, payload };
}

function readFullCache() {
  return normalizeFullCache(readJson(FULL_CACHE_PATH));
}

function readLiveCache() {
  const saved = readJson(LIVE_CACHE_PATH);
  if (saved?.payload?.ok) return { at: Number(saved.at) || 0, payload: saved.payload };
  const full = readFullCache();
  if (!full) return null;
  return { at: full.at, payload: { ...full.payload, cached: true, stale: true, liveOnly: true } };
}

function writeFullCache(cache) {
  writeJson(FULL_CACHE_PATH, cache);
}

function writeLiveCache(cache) {
  writeJson(LIVE_CACHE_PATH, cache);
}

function readIntradayCache() {
  const saved = readJson(INTRADAY_CACHE_PATH);
  if (saved?.payload?.ok) return saved;
  return null;
}

function readHsiLiveCache() {
  const saved = readJson(HSI_LIVE_CACHE_PATH);
  if (saved?.payload?.ok || saved?.payload?.price) return saved;
  return null;
}

function writeHsiLiveCache(cache) {
  writeJson(HSI_LIVE_CACHE_PATH, cache);
}

function persistFutuOpenInterest(payload) {
  const snapshots = payload?.snapshots;
  const futures = snapshots?.["HK.HSImain"];
  const liveValue = Number(futures?.openInterest);
  const liveDate = typeof futures?.updateTime === "string" ? futures.updateTime.slice(0, 10) : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(liveDate) || !Number.isFinite(liveValue) || liveValue <= 0) return;
  marketDb.upsertOpenInterest([{
    date: liveDate,
    value: liveValue,
    change: Number.isFinite(Number(futures?.openInterestChange)) ? Number(futures.openInterestChange) : null,
  }], "Futu HK.HSImain snapshot", new Date().toISOString());
}

module.exports = {
  FULL_CACHE_PATH,
  LIVE_CACHE_PATH,
  INTRADAY_CACHE_PATH,
  HSI_LIVE_CACHE_PATH,
  EXPIRY_SELECTION_POLICY,
  readJson,
  writeJson,
  readFullCache,
  readLiveCache,
  writeFullCache,
  writeLiveCache,
  readIntradayCache,
  INTRADAY_CACHE_PATH,
  readHsiLiveCache,
  writeHsiLiveCache,
  persistFutuOpenInterest,
};
