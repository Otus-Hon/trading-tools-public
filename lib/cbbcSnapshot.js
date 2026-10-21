/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("fs");
const path = require("path");
const { upsertCbbcSnapshot } = require("./marketDb");
const { dataPath } = require("./dataPaths");

const BASE_URL = "https://www.jpmhkwarrants.com/hk/data/json/cbbcBandJSON.php";
const DATA_PATH = dataPath("mirrors", "cbbc_outstanding.json");
const TIMEOUT_MS = 10_000;

const HEADERS = {
  Accept: "application/json, text/plain, */*",
  Referer: "https://www.jpmhkwarrants.com/zh_hk/cbbc/cbbc-outstanding/HSI",
  Origin: "https://www.jpmhkwarrants.com",
  "X-Requested-With": "XMLHttpRequest",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
};

function getHongKongDate() {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function buildSourceUrl() {
  const params = new URLSearchParams({
    ucode: "HSI",
    spread: "100",
    // JPM's own page initializes udate as blank, which means "latest available"
    // outstanding date. For 2026-06-16 this feed still reports sdate=2026-06-15.
    sdate: "",
    step: "15",
    _: String(Date.now()),
  });
  return `${BASE_URL}?${params.toString()}`;
}

function parseNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/,/g, "").trim();
  if (!cleaned) return null;
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal, cache: "no-store" });
  } finally {
    clearTimeout(timeout);
  }
}

function buildHistory(row, udates) {
  if (!Array.isArray(udates)) return [];
  return udates
    .map((date, index) => {
      const count = parseNumber(row?.[`d${index + 1}`]);
      if (typeof date !== "string" || !date || count === null) return null;
      return {
        date: date.slice(0, 10),
        count: Math.round(count),
      };
    })
    .filter(Boolean);
}

function cleanRows(mainData, udates) {
  if (!Array.isArray(mainData)) return [];
  const rows = [];
  for (const row of mainData) {
    const ty = row?.ty;
    const fr = parseNumber(row?.fr);
    const to = parseNumber(row?.to);
    const d1 = parseNumber(row?.d1);
    const dchng = parseNumber(row?.dchng);
    if (!ty || fr === null || to === null || d1 === null) continue;
    rows.push({
      side: String(ty),
      start: Math.round(fr),
      end: Math.round(to),
      count: Math.round(d1),
      change: dchng !== null ? Math.round(dchng) : null,
      history: buildHistory(row, udates),
    });
  }
  return rows;
}

async function fetchCbbcSnapshot() {
  const sourceUrl = buildSourceUrl();
  const res = await fetchWithTimeout(sourceUrl, { headers: HEADERS });
  const bodyText = await res.text();
  const trimmed = bodyText.trim();

  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    err.snippet = trimmed.slice(0, 200);
    throw err;
  }
  if (!trimmed.startsWith("{")) {
    const err = new Error("Unexpected response (not JSON object)");
    err.status = 500;
    err.snippet = trimmed.slice(0, 200);
    throw err;
  }

  const data = JSON.parse(trimmed);
  const furtherData =
    data && typeof data.furtherData === "object" && data.furtherData !== null
      ? data.furtherData
      : {};

  const meta = {
    ulast: parseNumber(furtherData.ulast),
    f_ulast: parseNumber(furtherData.f_ulast),
    hsilast: parseNumber(furtherData.hsilast),
    sdate: furtherData.sdate ?? null,
    stime: furtherData.stime ?? null,
    sumBull: parseNumber(Array.isArray(furtherData.sumBull) ? furtherData.sumBull[0] : furtherData.sumBull),
    sumBear: parseNumber(Array.isArray(furtherData.sumBear) ? furtherData.sumBear[0] : furtherData.sumBear),
  };
  const udates = Array.isArray(furtherData.udates)
    ? furtherData.udates.map((date) => String(date).slice(0, 10)).filter(Boolean)
    : [];

  const rawRows = cleanRows(data?.mainData || [], udates);
  const rows = rawRows.filter((row) => row.end - row.start === 99);
  const bearRows = rows
    .filter((row) => row.side === "bear")
    .sort((a, b) => b.start - a.start);
  const bullRows = rows
    .filter((row) => row.side === "bull")
    .sort((a, b) => b.start - a.start);

  return {
    fetched_at_utc: new Date().toISOString(),
    source_url: sourceUrl,
    meta,
    udates,
    bearRows,
    bullRows,
  };
}

function writeSnapshot(payload) {
  upsertCbbcSnapshot(payload);
  const json = JSON.stringify(payload, null, 2);
  fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
  fs.writeFileSync(DATA_PATH, json, { encoding: "utf8", flag: "w" });
}

async function refreshCbbcSnapshot() {
  const payload = await fetchCbbcSnapshot();
  writeSnapshot(payload);
  return payload;
}

function readCbbcSnapshotMirror() {
  for (const filePath of [DATA_PATH]) {
    try {
      if (!fs.existsSync(filePath)) continue;
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // Try the next mirror.
    }
  }
  return null;
}

function getSnapshotFreshness(snapshot, maxAgeMs) {
  const fetchedAt = Date.parse(snapshot?.fetched_at_utc || "");
  const ageMs = Number.isFinite(fetchedAt) ? Date.now() - fetchedAt : Infinity;
  const hkDate = getHongKongDate();
  const stime = typeof snapshot?.meta?.stime === "string" ? snapshot.meta.stime : "";
  const sourceUpdateDate = stime.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? null;
  const outstandingDate =
    typeof snapshot?.meta?.sdate === "string" ? snapshot.meta.sdate.slice(0, 10) : null;

  return {
    ageMs,
    hkDate,
    sourceUpdateDate,
    outstandingDate,
    isFreshFetch: Number.isFinite(ageMs) && ageMs <= maxAgeMs,
    isCurrentSession: sourceUpdateDate === hkDate,
    isOutstandingToday: outstandingDate === hkDate,
  };
}

module.exports = {
  refreshCbbcSnapshot,
  getSnapshotFreshness,
  readCbbcSnapshotMirror,
};
