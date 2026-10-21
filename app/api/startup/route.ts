import { NextResponse } from "next/server";
import publicModeModule from "../../../lib/publicMode.js";

export const runtime = "nodejs";
const { isPublicMode } = publicModeModule as unknown as { isPublicMode: () => boolean };

type JsonObject = Record<string, any>;

type EndpointResult = {
  ok: boolean;
  status: number;
  data: JsonObject | null;
  error: string | null;
};

const FETCH_TIMEOUT_MS = 20_000;

function hkDateNow() {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

async function fetchJson(url: string, init: RequestInit = {}): Promise<EndpointResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      cache: "no-store",
    });
    const text = await response.text();
    let data: JsonObject | null = null;

    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text.slice(0, 300) };
    }

    return {
      ok: response.ok && data?.ok !== false,
      status: response.status,
      data,
      error: response.ok ? null : `${response.status} ${text.slice(0, 180)}`,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      data: null,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function validateCbbc(latest: EndpointResult, warnings: string[], errors: string[]) {
  const data = latest.data;
  const bearRows = Array.isArray(data?.bearRows) ? data.bearRows : [];
  const bullRows = Array.isArray(data?.bullRows) ? data.bullRows : [];
  const freshness = data?.freshness || {};

  if (!latest.ok) {
    errors.push(`CBBC latest unavailable: ${latest.error || data?.error || "unknown error"}`);
    return {
      ok: false,
      bearRows: 0,
      bullRows: 0,
      sourceUpdateDate: null,
      outstandingDate: null,
    };
  }

  if (bearRows.length === 0 || bullRows.length === 0) {
    errors.push(`CBBC rows incomplete: bear=${bearRows.length}, bull=${bullRows.length}`);
  }

  if (freshness.isCurrentSession === false) {
    warnings.push(
      `CBBC source update is ${freshness.sourceUpdateDate || "unknown"}, not HK today ${hkDateNow()}`
    );
  }

  if (freshness.isOutstandingToday === false) {
    warnings.push(
      `CBBC outstanding date is ${freshness.outstandingDate || "unknown"}; this can be normal before JPM publishes today's outstanding snapshot`
    );
  }

  return {
    ok: bearRows.length > 0 && bullRows.length > 0,
    bearRows: bearRows.length,
    bullRows: bullRows.length,
    sourceUpdateDate: freshness.sourceUpdateDate || null,
    outstandingDate: freshness.outstandingDate || null,
    fetchedAt: data?.fetched_at_utc || null,
  };
}

function validateMoneyFlow(
  refresh: EndpointResult,
  longStored: EndpointResult,
  shortStored: EndpointResult,
  warnings: string[],
  errors: string[]
) {
  const data = refresh.data;
  const storedLongRows = Array.isArray(longStored.data?.rows) ? longStored.data.rows.length : 0;
  const storedShortRows = Array.isArray(shortStored.data?.rows) ? shortStored.data.rows.length : 0;
  const longRows = Number.isFinite(Number(data?.long_rows)) ? Number(data?.long_rows) : storedLongRows;
  const shortRows = Number.isFinite(Number(data?.short_rows)) ? Number(data?.short_rows) : storedShortRows;

  if (!refresh.ok) {
    const message = refresh.error || data?.error || "unknown error";
    if (refresh.status === 429 && storedLongRows > 0 && storedShortRows > 0) {
      warnings.push(`Money flow refresh skipped by cooldown; using stored rows long=${storedLongRows}, short=${storedShortRows}`);
    } else if (storedLongRows > 0 && storedShortRows > 0) {
      warnings.push(`Money flow refresh failed (${message}); using stored rows long=${storedLongRows}, short=${storedShortRows}`);
    } else {
      errors.push(`Money flow refresh failed: ${message}`);
      return { ok: false, longRows: 0, shortRows: 0 };
    }
  }

  if (longRows <= 0 || shortRows <= 0) {
    errors.push(`Money flow rows incomplete: long=${data?.long_rows ?? 0}, short=${data?.short_rows ?? 0}`);
  }

  if (refresh.ok && !data?.fetched_at_utc) {
    warnings.push("Money flow refresh succeeded but did not report a fetch timestamp");
  }

  return {
    ok: longRows > 0 && shortRows > 0,
    longRows,
    shortRows,
    fetchedAt: data?.fetched_at_utc || longStored.data?.fetched_at_utc || shortStored.data?.fetched_at_utc || null,
  };
}

function validateHsi(history: EndpointResult, live: EndpointResult, warnings: string[], errors: string[]) {
  const candles = Array.isArray(history.data?.candles) ? history.data?.candles : [];
  const badCandle = candles.find((candle: JsonObject) => {
    return !(
      isPositiveNumber(Number(candle?.open)) &&
      isPositiveNumber(Number(candle?.high)) &&
      isPositiveNumber(Number(candle?.low)) &&
      isPositiveNumber(Number(candle?.close)) &&
      Number(candle?.low) <= Number(candle?.high)
    );
  });
  const last = candles[candles.length - 1] || null;

  if (!history.ok) {
    errors.push(`HSI history unavailable: ${history.error || history.data?.error || "unknown error"}`);
  } else if (candles.length === 0) {
    errors.push("HSI history returned no candles");
  } else if (badCandle) {
    errors.push(`HSI history contains invalid candle at ${badCandle.time || "unknown date"}`);
  }

  if (!live.ok) {
    warnings.push(`HSI live feed unavailable: ${live.error || live.data?.error || "unknown error"}`);
  } else if (!isPositiveNumber(Number(live.data?.price))) {
    warnings.push("HSI live feed returned no positive price");
  }

  return {
    ok: history.ok && candles.length > 0 && !badCandle,
    candles: candles.length,
    lastCandle: last
      ? {
          time: last.time,
          open: Number(last.open),
          high: Number(last.high),
          low: Number(last.low),
          close: Number(last.close),
        }
      : null,
    livePrice: isPositiveNumber(Number(live.data?.price)) ? Number(live.data?.price) : null,
    source: history.data?.source || null,
  };
}

export async function POST(request: Request) {
  if (isPublicMode()) {
    return NextResponse.json({ ok: false, error: "Startup mutation checks are disabled on the public website." }, { status: 403 });
  }
  const origin = new URL(request.url).origin;
  const warnings: string[] = [];
  const errors: string[] = [];

  const [cbbcRefresh, moneyFlowRefresh] = await Promise.all([
    fetchJson(`${origin}/api/cbbc/refresh`, { method: "POST" }),
    fetchJson(`${origin}/api/moneyflow/refresh`, { method: "POST" }),
  ]);

  if (!cbbcRefresh.ok && cbbcRefresh.status !== 429) {
    warnings.push(`CBBC forced refresh failed: ${cbbcRefresh.error || cbbcRefresh.data?.error || "unknown error"}`);
  }
  if (!moneyFlowRefresh.ok && moneyFlowRefresh.status === 429) {
    warnings.push("Money flow refresh was skipped by cooldown; validating the current app state instead");
  }

  const [cbbcLatest, moneyFlowLong, moneyFlowShort, hsiHistory, hsiLive] = await Promise.all([
    fetchJson(`${origin}/api/cbbc/latest`),
    fetchJson(`${origin}/api/moneyflow/long`),
    fetchJson(`${origin}/api/moneyflow/short`),
    fetchJson(`${origin}/api/hsi?years=5`),
    fetchJson(`${origin}/api/hsi/live`),
  ]);

  const cbbc = validateCbbc(cbbcLatest, warnings, errors);
  const moneyFlow = validateMoneyFlow(moneyFlowRefresh, moneyFlowLong, moneyFlowShort, warnings, errors);
  const hsi = validateHsi(hsiHistory, hsiLive, warnings, errors);
  const ok = errors.length === 0;

  return NextResponse.json(
    {
      ok,
      hkDate: hkDateNow(),
      checkedAt: new Date().toISOString(),
      checks: {
        cbbc,
        moneyFlow,
        hsi,
      },
      warnings,
      errors,
    },
    { status: ok ? 200 : 502, headers: { "Cache-Control": "no-store" } }
  );
}
