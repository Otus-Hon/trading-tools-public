export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { fetchHsiLive } from "@/lib/hsiLive";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const {
  upsertMarketQuotes,
  readMarketQuotes,
} = require("@/lib/marketDb");

const CACHE_TTL_MS = 2_500;
const FETCH_TIMEOUT_MS = 9_000;

const SYMBOLS = [
  { symbol: "^HSI",     label: "HSI" },
  { symbol: "USDHKD=X", label: "USD/HKD" },
  { symbol: "^DJI",     label: "Dow Jones" },
  { symbol: "^IXIC",    label: "NASDAQ" },
  { symbol: "^GSPC",    label: "S&P 500" },
  { symbol: "GC=F",     label: "Gold" },
  { symbol: "BTC-USD",  label: "BTC/USD" },
  { symbol: "QQQ",      label: "QQQ" },
  { symbol: "SQQQ",     label: "SQQQ" },
  { symbol: "CL=F",     label: "Oil (WTI)" },
] as const;

type Quote = {
  symbol: string;
  label: string;
  price: number | null;
  change: number | null;
  changePercent: number | null;
};

let lastFetch = 0;

async function fetchWithTimeout(url: string, init?: RequestInit) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal, cache: "no-store" });
  } finally {
    clearTimeout(timeout);
  }
}

function emptyQuote(symbol: string, label: string): Quote {
  return { symbol, label, price: null, change: null, changePercent: null };
}


type YahooChart = {
  chart?: {
    result?: Array<{
      meta?: {
        regularMarketPrice?: number;
        chartPreviousClose?: number;
        previousClose?: number;
        regularMarketChange?: number;
        regularMarketChangePercent?: number;
      };
      timestamp?: number[];
      indicators?: { quote?: Array<{ close?: (number | null)[] }> };
    }>;
  };
};

// Fetch a symbol from Yahoo v8 chart — returns live price + true daily change.
// Use range=1d: meta.regularMarketPrice is the live price and meta.chartPreviousClose
// is the *actual previous session close* (yesterday). With a wider range,
// chartPreviousClose becomes the close before the whole window, which is wrong.
async function fetchYahooChart(symbol: string, label: string): Promise<Quote> {
  try {
    const encoded = encodeURIComponent(symbol);
    const headers = { "User-Agent": "Mozilla/5.0", Accept: "application/json" };

    const res = await fetchWithTimeout(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encoded}?interval=1d&range=1d`,
      { headers }
    );
    if (!res.ok) return emptyQuote(symbol, label);

    const json = (await res.json()) as YahooChart;
    const meta = json?.chart?.result?.[0]?.meta;

    const price = typeof meta?.regularMarketPrice === "number" ? meta.regularMarketPrice : null;
    if (price === null) return emptyQuote(symbol, label);

    const prevClose = typeof meta?.chartPreviousClose === "number"
      ? meta.chartPreviousClose
      : typeof meta?.previousClose === "number"
        ? meta.previousClose
        : null;

    const change = prevClose !== null ? price - prevClose : null;
    const changePercent = change !== null && prevClose !== null && prevClose !== 0
      ? (change / prevClose) * 100 : null;

    return { symbol, label, price, change, changePercent };
  } catch {
    return emptyQuote(symbol, label);
  }
}

type BinanceTicker = {
  lastPrice?: string;
  priceChange?: string;
  priceChangePercent?: string;
};

// Binance public ticker — single request, ~50ms, no auth needed
async function fetchBtcBinance(): Promise<Quote> {
  try {
    const res = await fetchWithTimeout(
      "https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT",
      { headers: { Accept: "application/json" } }
    );
    if (!res.ok) return emptyQuote("BTC-USD", "BTC/USD");

    const t = (await res.json()) as BinanceTicker;
    const price = parseFloat(t.lastPrice ?? "");
    const change = parseFloat(t.priceChange ?? "");
    const changePercent = parseFloat(t.priceChangePercent ?? "");

    if (!Number.isFinite(price)) return emptyQuote("BTC-USD", "BTC/USD");

    return {
      symbol: "BTC-USD", label: "BTC/USD",
      price,
      change: Number.isFinite(change) ? change : null,
      changePercent: Number.isFinite(changePercent) ? changePercent : null,
    };
  } catch (e) {
    void e;
    return emptyQuote("BTC-USD", "BTC/USD");
  }
}

async function refreshQuotes(): Promise<{ updatedAt: string; quotes: Quote[] }> {
  // Cash quotes from Yahoo, BTC from Binance, and the real-time HSI cash index from
  // Tencent's r_hkHSI feed (replaces Yahoo's 15-min-delayed ^HSI for the HSI row).
  const yahooSymbols = SYMBOLS.filter((s) => s.symbol !== "BTC-USD");

  const [fetched, hsiLive] = await Promise.all([
    Promise.all([
      ...yahooSymbols.map(({ symbol, label }) => fetchYahooChart(symbol, label)),
      fetchBtcBinance(),
    ]),
    fetchHsiLive(),
  ]);

  const fetchedMap = new Map(fetched.map((q) => [q.symbol, q]));
  // Prefer the real-time cash feed; fall back to the (delayed) Yahoo ^HSI only if it's down.
  if (hsiLive) {
    fetchedMap.set("^HSI", {
      symbol: "^HSI",
      label: "HSI",
      price: hsiLive.price,
      change: hsiLive.change,
      changePercent: hsiLive.changePercent,
    });
  }

  const quotes: Quote[] = SYMBOLS.map(({ symbol, label }) =>
    fetchedMap.get(symbol) ?? emptyQuote(symbol, label)
  );

  const dbQuotes = quotes.map((q) => ({
    symbol: q.symbol,
    label: q.label,
    price: q.price,
    volume: null,
    change: q.change,
    changePercent: q.changePercent,
  }));

  if (quotes.some((q) => q.price !== null)) {
    upsertMarketQuotes(dbQuotes, "yahoo-v8");
  }

  lastFetch = Date.now();
  return { updatedAt: new Date().toISOString(), quotes };
}

let refreshInFlight = false;

export async function GET() {
  try {
    const cached = readMarketQuotes();
    const cacheAge = cached?.updatedAt && !Number.isNaN(new Date(cached.updatedAt).getTime())
      ? Date.now() - new Date(cached.updatedAt).getTime()
      : Number.POSITIVE_INFINITY;
    const cachedHasData = Array.isArray(cached?.quotes)
      ? cached.quotes.some((q: Quote) => q.price !== null)
      : false;

    const needsRefresh = !cachedHasData || cacheAge >= CACHE_TTL_MS;

    // Always return cached data immediately if we have it — don't make the user wait
    if (cachedHasData) {
      if (needsRefresh && !refreshInFlight) {
        refreshInFlight = true;
        refreshQuotes().finally(() => { refreshInFlight = false; });
      }
      return NextResponse.json({ updatedAt: cached.updatedAt, quotes: cached.quotes }, { status: 200 });
    }

    // No cached data at all — must wait for live fetch
    const fresh = await refreshQuotes();
    return NextResponse.json(fresh, { status: 200 });
  } catch (error) {
    console.error("[markets] GET failed", error);
    const cached = readMarketQuotes();
    if (cached?.quotes?.length) {
      return NextResponse.json({ updatedAt: cached.updatedAt, quotes: cached.quotes }, { status: 200 });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to fetch markets" },
      { status: 502 }
    );
  }
}
