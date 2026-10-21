import { NextRequest, NextResponse } from "next/server";

const PUBLIC_MODE = process.env.TRADING_TOOLS_PUBLIC_MODE === "1"
  || process.env.NEXT_PUBLIC_TRADING_TOOLS_PUBLIC_MODE === "1";

const PRIVILEGED_PATHS = new Set([
  "/api/backtest/run",
  "/api/backtest/refresh",
  "/api/futu/candles",
  "/api/startup",
  "/api/cbbc/refresh",
  "/api/moneyflow/refresh",
]);

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const MAX_PATH = 256;
const MAX_QUERY = 512;
const MAX_JSON_BODY = 16_384;
const WINDOW_MS = 60_000;
const DEFAULT_LIMIT = 90;
const EXPENSIVE_LIMIT = 20;
const GLOBAL_PATH_LIMIT = 600;
const MAX_BUCKETS = 10_000;
const buckets = new Map<string, { start: number; count: number }>();

function clientKey(request: NextRequest) {
  const forwarded = request.headers.get("x-forwarded-for") || request.headers.get("x-real-ip") || "";
  return forwarded.split(",")[0].trim() || request.headers.get("x-forwarded-host") || "local";
}

function takeToken(key: string, limit: number) {
  const now = Date.now();
  if (buckets.size > MAX_BUCKETS) {
    for (const [bucketKey, value] of buckets) {
      if (now - value.start >= WINDOW_MS) buckets.delete(bucketKey);
    }
    if (buckets.size > MAX_BUCKETS) buckets.clear();
  }
  const bucket = buckets.get(key);
  if (!bucket || now - bucket.start >= WINDOW_MS) {
    buckets.set(key, { start: now, count: 1 });
    return { allowed: true as const };
  }
  if (bucket.count >= limit) {
    return {
      allowed: false as const,
      retryAfter: Math.max(1, Math.ceil((bucket.start + WINDOW_MS - now) / 1000)),
    };
  }
  bucket.count += 1;
  return { allowed: true as const };
}

function jsonError(status: number, error: string, extra?: Record<string, string>) {
  return NextResponse.json({ ok: false, error }, { status, headers: extra });
}

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (pathname.length > MAX_PATH || search.length > MAX_QUERY) {
    return jsonError(414, "Request is too large.");
  }

  const contentLength = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_JSON_BODY) {
    return jsonError(413, "Request body is too large.");
  }

  if (PUBLIC_MODE && MUTATING_METHODS.has(request.method) && pathname.startsWith("/api/")) {
    return jsonError(403, "Public requests cannot modify server data or invoke administrative functions.");
  }

  if (PUBLIC_MODE && PRIVILEGED_PATHS.has(pathname)) {
    return jsonError(403, "This administrative endpoint is disabled on the public website.");
  }

  const expensive = pathname === "/api/backtest/auto"
    || pathname === "/api/backtest/candles"
    || pathname === "/api/hsi";
  const limit = expensive ? EXPENSIVE_LIMIT : DEFAULT_LIMIT;
  const globalRate = takeToken(`global:${pathname}`, GLOBAL_PATH_LIMIT);
  if (!globalRate.allowed) {
    return jsonError(429, "Service request limit reached.", { "Retry-After": String(globalRate.retryAfter) });
  }
  const rate = takeToken(`${clientKey(request)}:${pathname}`, limit);
  if (!rate.allowed) {
    return jsonError(429, "Too many requests.", { "Retry-After": String(rate.retryAfter) });
  }

  return NextResponse.next();
}

export const config = {
  matcher: "/api/:path*",
};
