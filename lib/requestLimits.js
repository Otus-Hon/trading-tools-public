const CHART_SYMBOLS = new Set([
  "^HSI",
  "USDHKD=X",
  "^DJI",
  "^IXIC",
  "^GSPC",
  "GC=F",
  "BTC-USD",
  "QQQ",
  "SQQQ",
  "CL=F",
  "0700.HK",
  "9988.HK",
  "0005.HK",
  "^HSTECH",
  "3032.HK",
  "CNH=X",
  "CNY=X",
  "CN=F",
  "2823.HK",
  "NQ=F",
  "ES=F",
]);

const MAX_API_PATH = 256;
const MAX_QUERY_CHARS = 512;
const MAX_JSON_BODY_BYTES = 16_384;
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT_DEFAULT = 90;
const RATE_LIMIT_EXPENSIVE = 20;
const buckets = new Map();

function clampInt(raw, min, max, fallback) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function isAllowedChartSymbol(symbol) {
  return typeof symbol === "string" && CHART_SYMBOLS.has(symbol);
}

function clientKey(request) {
  const forwarded = request.headers?.get?.("x-forwarded-for") || request.headers?.get?.("x-real-ip") || "";
  const first = String(forwarded).split(",")[0].trim();
  return first || request.ip || "local";
}

function takeToken(key, limit = RATE_LIMIT_DEFAULT) {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || now - bucket.start >= RATE_WINDOW_MS) {
    buckets.set(key, { start: now, count: 1 });
    return { allowed: true, remaining: limit - 1 };
  }
  if (bucket.count >= limit) {
    return { allowed: false, remaining: 0, retryAfter: Math.ceil((bucket.start + RATE_WINDOW_MS - now) / 1000) };
  }
  bucket.count += 1;
  return { allowed: true, remaining: limit - bucket.count };
}

function expensiveLimitPath(pathname) {
  return pathname === "/api/backtest/auto" || pathname === "/api/backtest/candles" || pathname === "/api/hsi";
}

function rateLimitForPath(pathname) {
  return expensiveLimitPath(pathname) ? RATE_LIMIT_EXPENSIVE : RATE_LIMIT_DEFAULT;
}

function pruneBuckets() {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (now - bucket.start >= RATE_WINDOW_MS * 2) buckets.delete(key);
  }
}

setInterval(pruneBuckets, RATE_WINDOW_MS).unref?.();

module.exports = {
  CHART_SYMBOLS,
  MAX_API_PATH,
  MAX_QUERY_CHARS,
  MAX_JSON_BODY_BYTES,
  RATE_WINDOW_MS,
  RATE_LIMIT_DEFAULT,
  RATE_LIMIT_EXPENSIVE,
  clampInt,
  isAllowedChartSymbol,
  clientKey,
  takeToken,
  rateLimitForPath,
};
