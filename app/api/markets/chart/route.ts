export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import dataPathsModule from "../../../../lib/dataPaths.js";
import publicModeModule from "../../../../lib/publicMode.js";
import requestLimitsModule from "../../../../lib/requestLimits.js";

const FETCH_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 min
const CACHE_KEY_VERSION = "v2";

type Candle = { time: string; open: number; high: number; low: number; close: number };
type CacheEntry = { candles: Candle[]; fetchedAt: number };
const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<Candle[]>>();
const { dataPath } = dataPathsModule as unknown as { dataPath: (...segments: string[]) => string };
const { isPublicMode } = publicModeModule as unknown as { isPublicMode: () => boolean };
const { isAllowedChartSymbol } = requestLimitsModule as unknown as { isAllowedChartSymbol: (symbol: string) => boolean };
const DISK_CACHE_PATH = dataPath("market_chart_cache.json");

try {
  const saved = JSON.parse(fs.readFileSync(DISK_CACHE_PATH, "utf8")) as Record<string, CacheEntry>;
  Object.entries(saved).forEach(([key, value]) => {
    if (Array.isArray(value?.candles) && value.candles.length) cache.set(key, value);
  });
} catch {
  // First run has no persistent cache yet.
}

function persistCache() {
  try {
    fs.mkdirSync(path.dirname(DISK_CACHE_PATH), { recursive: true });
    fs.writeFileSync(DISK_CACHE_PATH, JSON.stringify(Object.fromEntries(cache)));
  } catch {
    // Memory caching remains available if disk persistence fails.
  }
}

async function fetchWithTimeout(url: string, init?: RequestInit) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal, cache: "no-store" });
  } finally {
    clearTimeout(timeout);
  }
}

function toIsoDate(timestamp: number): string {
  return new Date(timestamp * 1000).toISOString().slice(0, 10);
}

async function fetchChartCandles(symbol: string, interval: string, forceRefresh = false): Promise<Candle[]> {
  if (interval !== "1d") {
    throw new Error("Only daily charts are supported");
  }

  const cacheKey = `${CACHE_KEY_VERSION}:${symbol}::${interval}`;
  const cached = cache.get(cacheKey);
  if (!forceRefresh && cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.candles;
  }

  const pending = inFlight.get(cacheKey);
  if (pending) return pending;

  const request = fetchChartCandlesUncached(symbol, interval, cacheKey);
  inFlight.set(cacheKey, request);
  try {
    return await request;
  } finally {
    inFlight.delete(cacheKey);
  }
}

async function fetchChartCandlesUncached(symbol: string, interval: string, cacheKey: string): Promise<Candle[]> {

  // A bounded range includes the current in-progress session for Yahoo's HK
  // symbols; period1=0 can stop at the previous close. Five years is more than
  // enough for the 260-session mini charts and keeps the payload compact.
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5y`;

  const res = await fetchWithTimeout(url, {
    headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);

  const json = await res.json() as {
    chart?: {
      result?: Array<{
        timestamp?: number[];
        indicators?: { quote?: Array<{ open?: (number|null)[]; high?: (number|null)[]; low?: (number|null)[]; close?: (number|null)[] }> };
      }>;
    };
  };

  const result = json?.chart?.result?.[0];
  const timestamps = result?.timestamp ?? [];
  const q = result?.indicators?.quote?.[0] ?? {};

  const candles: Candle[] = timestamps
    .map((ts, i) => ({
      time: toIsoDate(ts),
      open: q.open?.[i] ?? null,
      high: q.high?.[i] ?? null,
      low: q.low?.[i] ?? null,
      close: q.close?.[i] ?? null,
    }))
    .filter((c): c is Candle =>
      c.close !== null && Number.isFinite(c.close) &&
      c.open !== null && c.high !== null && c.low !== null
    )
    .sort((a, b) => a.time.localeCompare(b.time));

  cache.set(cacheKey, { candles, fetchedAt: Date.now() });
  persistCache();
  return candles;
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const symbol = searchParams.get("symbol") ?? "";
  const forceRefresh = !isPublicMode() && searchParams.get("refresh") === "1";
  const interval = "1d";

  if (!symbol) {
    return NextResponse.json({ error: "symbol required" }, { status: 400 });
  }
  if (!isAllowedChartSymbol(symbol)) {
    return NextResponse.json({ error: "Unsupported symbol." }, { status: 400 });
  }

  try {
    const cacheKey = `${CACHE_KEY_VERSION}:${symbol}::${interval}`;
    if (forceRefresh) {
      const candles = await fetchChartCandles(symbol, interval, true);
      return NextResponse.json(
        { symbol, interval, candles, cached: false },
        { status: 200, headers: { "Cache-Control": "no-store" } }
      );
    }
    const stale = cache.get(cacheKey);
    // Stale-while-revalidate: render saved data immediately and refresh off-screen.
    if (stale?.candles?.length) {
      if (!isPublicMode() && Date.now() - stale.fetchedAt >= CACHE_TTL_MS) {
        fetchChartCandles(symbol, interval).catch(() => {});
      }
      return NextResponse.json(
        { symbol, interval, candles: stale.candles, cached: true },
        { status: 200, headers: { "Cache-Control": "public, max-age=60, stale-while-revalidate=900" } }
      );
    }
    if (isPublicMode()) {
      return NextResponse.json(
        { error: "No stored chart data is available for this symbol." },
        { status: 503, headers: { "Cache-Control": "no-store" } }
      );
    }
    const candles = await fetchChartCandles(symbol, interval);
    return NextResponse.json(
      { symbol, interval, candles, cached: false },
      { status: 200, headers: { "Cache-Control": "public, max-age=60, stale-while-revalidate=900" } }
    );
  } catch {
    return NextResponse.json(
      { error: "Chart data is unavailable." },
      { status: 502, headers: { "Cache-Control": "no-store" } }
    );
  }
}
