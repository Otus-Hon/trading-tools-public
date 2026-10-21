/* eslint-disable @typescript-eslint/no-require-imports */
const STOOQ_HISTORY_URL = "https://stooq.com/q/d/?s=^hsi&i=d";
const YAHOO_HISTORY_URLS = [
  "https://query1.finance.yahoo.com/v8/finance/chart/%5EHSI",
  "https://query2.finance.yahoo.com/v8/finance/chart/%5EHSI",
];
const STOOQ_TIMEOUT_MS = 2500;
const YAHOO_TIMEOUT_MS = 5000;
import publicModeModule from "../../../lib/publicMode.js";
const { isPublicMode } = publicModeModule as unknown as { isPublicMode: () => boolean };

const {
  readMoneyFlowLong,
  readHsiCandles,
  readLatestCbbcSnapshot,
  upsertHsiCandles,
} = require("@/lib/marketDb");

type Candle = {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
};

type MoneyFlowRow = {
  date?: string;
  underlying_last?: number | string;
  underlying_pct_change?: number | string;
};

type CbbcSnapshot = {
  fetched_at_utc?: string | null;
  meta?: {
    ulast?: number | string | null;
    hsilast?: number | string | null;
    stime?: string | null;
  } | null;
} | null;

const MONTH_MAP: Record<string, string> = {
  Jan: "01",
  Feb: "02",
  Mar: "03",
  Apr: "04",
  May: "05",
  Jun: "06",
  Jul: "07",
  Aug: "08",
  Sep: "09",
  Oct: "10",
  Nov: "11",
  Dec: "12",
};

function formatCompactDate(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

function parseStooqDate(raw: string): string | null {
  const normalized = raw.replace(/\s+/g, " ").trim();
  const match = normalized.match(/^(\d{1,2}) ([A-Z][a-z]{2}) (\d{4})$/);
  if (!match) return null;

  const [, day, monthName, year] = match;
  const month = MONTH_MAP[monthName];
  if (!month) return null;

  return `${year}-${month}-${day.padStart(2, "0")}`;
}

function parseNumber(raw: string): number | null {
  const normalized = raw.replace(/,/g, "").trim();
  if (!normalized) return null;
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

function parseStooqHistoryPage(html: string): Candle[] {
  const rowPattern =
    /<tr><td align=center id=t03>\d+<\/td><td nowrap>([^<]+)<\/td><td>([^<]*)<\/td><td>([^<]*)<\/td><td>([^<]*)<\/td><td>([^<]*)<\/td><td id=c[123]>[^<]*<\/td><td id=c[123]>[^<]*<\/td><td>([^<]*)<\/td><\/tr>/g;

  const candles: Candle[] = [];
  let match: RegExpExecArray | null = null;

  while ((match = rowPattern.exec(html)) !== null) {
    const [, dateRaw, openRaw, highRaw, lowRaw, closeRaw, volumeRaw] = match;
    const time = parseStooqDate(dateRaw);
    const open = parseNumber(openRaw);
    const high = parseNumber(highRaw);
    const low = parseNumber(lowRaw);
    const close = parseNumber(closeRaw);
    const volume = parseNumber(volumeRaw);

    if (!time || open === null || high === null || low === null || close === null) {
      continue;
    }

    candles.push({
      time,
      open,
      high,
      low,
      close,
      ...(volume !== null ? { volume } : {}),
    });
  }

  return candles;
}

function isFinitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function buildMoneyFlowRepairMap(rows: MoneyFlowRow[]) {
  const byDate = new Map<
    string,
    {
      close: number;
      pctChange: number | null;
    }
  >();

  for (const row of rows) {
    const date = typeof row?.date === "string" ? row.date.slice(0, 10) : "";
    const close = Number(row?.underlying_last);
    const pctChange = Number(row?.underlying_pct_change);
    if (!date || !isFinitePositive(close)) continue;

    byDate.set(date, {
      close,
      pctChange: Number.isFinite(pctChange) ? pctChange : null,
    });
  }

  return byDate;
}

function sanitizeCandles(candles: Candle[], moneyFlowRows: MoneyFlowRow[]): Candle[] {
  const repairMap = buildMoneyFlowRepairMap(moneyFlowRows);
  const sanitized: Candle[] = [];

  for (const candle of candles) {
    if (!candle?.time) continue;

    let open = Number(candle.open);
    let high = Number(candle.high);
    let low = Number(candle.low);
    let close = Number(candle.close);
    const volume = Number(candle.volume);
    const repair = repairMap.get(candle.time);

    if (!isFinitePositive(close) && repair) {
      close = repair.close;
    }

    if (!isFinitePositive(open)) {
      if (repair && repair.pctChange !== null && repair.pctChange !== -100) {
        open = close / (1 + repair.pctChange / 100);
      } else if (sanitized.length > 0) {
        open = sanitized[sanitized.length - 1].close;
      } else {
        open = close;
      }
    }

    const priceCandidates = [open, high, low, close].filter(isFinitePositive);
    if (priceCandidates.length < 2) {
      continue;
    }

    high = Math.max(...priceCandidates);
    low = Math.min(...priceCandidates);

    if (!isFinitePositive(open) || !isFinitePositive(close) || low > high) {
      continue;
    }

    sanitized.push({
      time: candle.time,
      open,
      high,
      low,
      close,
      ...(Number.isFinite(volume) && volume >= 0 ? { volume } : {}),
    });
  }

  sanitized.sort((a, b) => a.time.localeCompare(b.time));
  return sanitized;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

type YahooHistoryQuote = {
  open?: unknown[];
  high?: unknown[];
  low?: unknown[];
  close?: unknown[];
  volume?: unknown[];
};

type YahooHistoryResponse = {
  chart?: {
    result?: Array<{
      timestamp?: unknown[];
      meta?: {
        regularMarketPrice?: unknown;
        regularMarketTime?: unknown;
      };
      indicators?: {
        quote?: YahooHistoryQuote[];
      };
    }>;
  };
};

function parseYahooHistoryJson(json: YahooHistoryResponse): Candle[] {
  const result = json?.chart?.result?.[0];
  const timestamps = Array.isArray(result?.timestamp) ? result.timestamp : [];
  const quote = result?.indicators?.quote?.[0];
  const opens = Array.isArray(quote?.open) ? quote.open : [];
  const highs = Array.isArray(quote?.high) ? quote.high : [];
  const lows = Array.isArray(quote?.low) ? quote.low : [];
  const closes = Array.isArray(quote?.close) ? quote.close : [];
  const volumes = Array.isArray(quote?.volume) ? quote.volume : [];

  // Yahoo often returns close=null for the most recent completed trading day
  // even though O/H/L are present; the real close lives in meta.regularMarketPrice.
  const metaPrice = Number(result?.meta?.regularMarketPrice);
  const metaTime = Number(result?.meta?.regularMarketTime);
  const metaDate =
    Number.isFinite(metaTime) && isFinitePositive(metaPrice)
      ? new Date(metaTime * 1000).toISOString().slice(0, 10)
      : null;

  const candles: Candle[] = [];

  for (let i = 0; i < timestamps.length; i += 1) {
    const ts = Number(timestamps[i]);
    const open = Number(opens[i]);
    const high = Number(highs[i]);
    const low = Number(lows[i]);
    let close = Number(closes[i]);
    const volume = Number(volumes[i]);

    const time = Number.isFinite(ts)
      ? new Date(ts * 1000).toISOString().slice(0, 10)
      : null;

    if (!Number.isFinite(close) && metaDate && time === metaDate) {
      close = metaPrice;
    }

    if (
      !time ||
      !Number.isFinite(open) ||
      !Number.isFinite(high) ||
      !Number.isFinite(low) ||
      !Number.isFinite(close)
    ) {
      continue;
    }

    candles.push({
      time,
      open,
      high,
      low,
      close,
      ...(Number.isFinite(volume) ? { volume } : {}),
    });
  }

  candles.sort((a, b) => a.time.localeCompare(b.time));
  return candles;
}

async function fetchStooqHistoryCandles(cutoff: Date): Promise<Candle[]> {
  const f = formatCompactDate(cutoff);
  const t = formatCompactDate(new Date());
  const all = new Map<string, Candle>();

  for (let page = 1; page <= 200; page += 1) {
    const url = `${STOOQ_HISTORY_URL}&f=${f}&t=${t}&l=${page}`;
    const response = await fetchWithTimeout(url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
      },
      cache: "no-store",
      next: { revalidate: 300 },
    }, STOOQ_TIMEOUT_MS);

    if (!response.ok) {
      throw new Error(`Stooq history HTTP ${response.status} on page ${page}`);
    }

    const html = await response.text();
    const candles = parseStooqHistoryPage(html);

    if (candles.length === 0) {
      break;
    }

    candles.forEach((candle) => {
      all.set(candle.time, candle);
    });

    if (candles.length < 40) {
      break;
    }
  }

  return [...all.values()].sort((a, b) => a.time.localeCompare(b.time));
}

async function fetchYahooHistoryCandles(cutoff: Date): Promise<Candle[]> {
  const period1 = Math.floor(cutoff.getTime() / 1000);
  const period2 = Math.floor(Date.now() / 1000) + 86400;
  let lastError: Error | null = null;

  for (const baseUrl of YAHOO_HISTORY_URLS) {
    const url = `${baseUrl}?interval=1d&includePrePost=false&events=history&period1=${period1}&period2=${period2}`;

    try {
      const response = await fetchWithTimeout(url, {
        headers: {
          "User-Agent": "Mozilla/5.0",
          Accept: "application/json",
        },
        cache: "no-store",
        next: { revalidate: 300 },
      }, YAHOO_TIMEOUT_MS);

      if (!response.ok) {
        throw new Error(`Yahoo history HTTP ${response.status}`);
      }

      const json = await response.json();
      return parseYahooHistoryJson(json);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  throw lastError ?? new Error("Yahoo history failed");
}

function buildFallbackCandlesFromMoneyFlow(
  rows: Array<{
    date?: string;
    underlying_last?: number | string;
    underlying_pct_change?: number | string;
  }>
): Candle[] {
  if (!Array.isArray(rows)) return [];

  const candles = rows
    .map((row) => {
      const time = typeof row?.date === "string" ? row.date.slice(0, 10) : "";
      const close = Number(row?.underlying_last);
      const pct = Number(row?.underlying_pct_change);

      if (!time || !Number.isFinite(close)) return null;

      const open =
        Number.isFinite(pct) && pct !== -100 ? close / (1 + pct / 100) : close;
      const high = Math.max(open, close);
      const low = Math.min(open, close);

      return {
        time,
        open,
        high,
        low,
        close,
      };
    })
    .filter((candle): candle is Candle => candle !== null);

  candles.sort((a, b) => a.time.localeCompare(b.time));
  return candles;
}

function mergeMissingMoneyFlowCandles(candles: Candle[], moneyFlowRows: MoneyFlowRow[]) {
  const merged = new Map<string, Candle>();
  for (const candle of candles) {
    if (candle?.time) merged.set(candle.time, candle);
  }

  let added = 0;
  for (const candle of buildFallbackCandlesFromMoneyFlow(moneyFlowRows)) {
    if (merged.has(candle.time)) continue;
    merged.set(candle.time, candle);
    added += 1;
  }

  return {
    candles: Array.from(merged.values()).sort((a, b) => a.time.localeCompare(b.time)),
    added,
  };
}

function getHongKongDateFromUtc(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

type HkTimeParts = {
  date: string;
  minutes: number;
  dayOfWeek: number;
};

function getHongKongTimePartsFromUtc(iso: string | null | undefined): HkTimeParts | null {
  if (!iso) return null;
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return null;

  const hkDate = new Date(timestamp + 8 * 60 * 60 * 1000);
  const year = hkDate.getUTCFullYear();
  const month = String(hkDate.getUTCMonth() + 1).padStart(2, "0");
  const day = String(hkDate.getUTCDate()).padStart(2, "0");
  const hours = hkDate.getUTCHours();
  const minutes = hkDate.getUTCMinutes();

  return {
    date: `${year}-${month}-${day}`,
    minutes: hours * 60 + minutes,
    dayOfWeek: hkDate.getUTCDay(),
  };
}

function parseHongKongTimeParts(raw: string | null | undefined): HkTimeParts | null {
  if (!raw) return null;
  const match = raw.match(
    /(\d{4})[-/](\d{2})[-/](\d{2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/
  );
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hours = match[4] === undefined ? 0 : Number(match[4]);
  const minutes = match[5] === undefined ? 0 : Number(match[5]);
  const date = `${match[1]}-${match[2]}-${match[3]}`;
  const utcDate = new Date(Date.UTC(year, month - 1, day, hours - 8, minutes, Number(match[6] ?? 0)));

  return {
    date,
    minutes: hours * 60 + minutes,
    dayOfWeek: utcDate.getUTCDay(),
  };
}

function hasHkCashMarketOpened(parts: HkTimeParts | null): boolean {
  if (!parts) return false;
  const isWeekday = parts.dayOfWeek >= 1 && parts.dayOfWeek <= 5;
  const continuousTradingStart = 9 * 60 + 30;
  return isWeekday && parts.minutes >= continuousTradingStart;
}

function getCbbcLiveTimeParts(snapshot: CbbcSnapshot): HkTimeParts | null {
  const stime = typeof snapshot?.meta?.stime === "string" ? snapshot.meta.stime : "";
  return parseHongKongTimeParts(stime) || getHongKongTimePartsFromUtc(snapshot?.fetched_at_utc);
}

function getCbbcLiveDate(snapshot: CbbcSnapshot): string | null {
  const liveTime = getCbbcLiveTimeParts(snapshot);
  return liveTime?.date || getHongKongDateFromUtc(snapshot?.fetched_at_utc);
}

function mergeLiveCbbcCandle(candles: Candle[]): Candle[] {
  const snapshot = readLatestCbbcSnapshot();
  const liveTime = getCbbcLiveTimeParts(snapshot);
  const liveDate = getCbbcLiveDate(snapshot);
  const liveClose = Number(snapshot?.meta?.ulast);

  if (!liveDate || !isFinitePositive(liveClose) || !hasHkCashMarketOpened(liveTime)) {
    return candles;
  }

  const merged = [...candles].sort((a, b) => a.time.localeCompare(b.time));
  const existingIndex = merged.findIndex((candle) => candle.time === liveDate);
  const previous =
    existingIndex > 0
      ? merged[existingIndex - 1]
      : merged.length > 0
        ? merged[merged.length - 1]
        : null;
  const previousClose = Number(snapshot?.meta?.hsilast);
  const open = isFinitePositive(previousClose)
    ? previousClose
    : previous && isFinitePositive(Number(previous.close))
      ? Number(previous.close)
      : liveClose;

  const liveCandle: Candle = {
    time: liveDate,
    open,
    high: Math.max(open, liveClose),
    low: Math.min(open, liveClose),
    close: liveClose,
  };

  if (existingIndex >= 0) {
    const existing = merged[existingIndex];
    merged[existingIndex] = {
      ...existing,
      close: liveClose,
      high: Math.max(Number(existing.high), liveClose, open),
      low: Math.min(Number(existing.low), liveClose, open),
      open: isFinitePositive(Number(existing.open)) ? Number(existing.open) : open,
    };
    return merged;
  }

  const latestDate = merged.length > 0 ? merged[merged.length - 1].time : null;
  if (!latestDate || liveDate > latestDate) {
    merged.push(liveCandle);
  }

  return merged;
}

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const yearsParam = requestUrl.searchParams.get("years");
  const parsedYears = Number(yearsParam ?? "5");
  const years = Number.isFinite(parsedYears) && parsedYears > 0
    ? Math.min(10, Math.max(1, Math.floor(parsedYears)))
    : 5;

  const now = new Date();
  const cutoff = new Date(
    Date.UTC(now.getUTCFullYear() - years, now.getUTCMonth(), now.getUTCDate())
  );
  const cutoffIso = cutoff.toISOString().slice(0, 10);
  const { rows: moneyFlowRows } = readMoneyFlowLong();
  let filtered: Candle[] = [];
  let source = "stooq";

  if (isPublicMode()) {
    const cached = readHsiCandles();
    const cachedCandles = Array.isArray(cached?.candles)
      ? sanitizeCandles(cached.candles, moneyFlowRows).filter((candle: Candle) => candle.time >= cutoffIso)
      : [];
    const repaired = mergeMissingMoneyFlowCandles(cachedCandles, moneyFlowRows);
    const candles = mergeLiveCbbcCandle(repaired.candles.filter((candle) => candle.time >= cutoffIso));
    return new Response(JSON.stringify({
      symbol: "HSI",
      candles,
      source: `${cached?.source || "stored-candles"}${repaired.added > 0 ? "+moneyflow-fill" : ""}+cbbc-live`,
      range: `${years}y`,
      cached: true,
      stale: true,
    }), {
      status: candles.length > 0 ? 200 : 503,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }

  try {
    const candles = await fetchStooqHistoryCandles(cutoff);
    filtered = sanitizeCandles(candles, moneyFlowRows).filter((candle) => candle.time >= cutoffIso);
  } catch (error) {
    console.error("[hsi] stooq history failed", error);
  }

  if (filtered.length === 0) {
    try {
      const candles = await fetchYahooHistoryCandles(cutoff);
      filtered = sanitizeCandles(candles, moneyFlowRows).filter((candle) => candle.time >= cutoffIso);
      source = "yahoo-chart-fallback";
    } catch (error) {
      console.error("[hsi] yahoo history fallback failed", error);
    }
  }

  if (filtered.length > 0) {
    const repaired = mergeMissingMoneyFlowCandles(filtered, moneyFlowRows);
    filtered = repaired.candles.filter((candle) => candle.time >= cutoffIso);
    if (repaired.added > 0) {
      source = `${source}+moneyflow-fill`;
    }
    filtered = mergeLiveCbbcCandle(filtered);
    source = `${source}+cbbc-live`;
    upsertHsiCandles(filtered, source);
  }

  if (filtered.length === 0) {
    const cached = readHsiCandles();
    const cachedCandles = Array.isArray(cached?.candles)
      ? sanitizeCandles(cached.candles, moneyFlowRows).filter(
          (candle: Candle) => candle.time >= cutoffIso
        )
      : [];
    if (cachedCandles.length > 0) {
      const repaired = mergeMissingMoneyFlowCandles(cachedCandles, moneyFlowRows);
      const candles = mergeLiveCbbcCandle(
        repaired.candles.filter((candle) => candle.time >= cutoffIso)
      );
      return new Response(
        JSON.stringify(
          {
            symbol: "HSI",
            candles,
            source: `${cached?.source || "cached-full-candles"}${
              repaired.added > 0 ? "+moneyflow-fill" : ""
            }+cbbc-live`,
            range: `${years}y`,
          },
          null,
          0
        ),
        {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "public, max-age=300, s-maxage=300, stale-while-revalidate=300",
          },
        }
      );
    }
  }

  if (filtered.length === 0) {
    const fallbackCandles = mergeLiveCbbcCandle(
      buildFallbackCandlesFromMoneyFlow(moneyFlowRows).filter(
        (candle) => candle.time >= cutoffIso
      )
    );

    return new Response(
      JSON.stringify(
        {
          symbol: "HSI",
          candles: fallbackCandles,
          source: "moneyflow-fallback",
          range: `${years}y`,
        },
        null,
        0
      ),
      {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=300, s-maxage=300, stale-while-revalidate=300",
        },
      }
    );
  }

  return new Response(
    JSON.stringify(
      {
        symbol: "HSI",
        candles: filtered,
        source,
        range: `${years}y`,
      },
      null,
      0
    ),
    {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=300, s-maxage=300, stale-while-revalidate=300",
      },
    }
  );
}
