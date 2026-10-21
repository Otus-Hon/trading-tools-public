/* eslint-disable @typescript-eslint/no-require-imports */
import fs from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import dataPathsModule from "../../../../lib/dataPaths.js";

const { readCandles, upsertCandles, coverage, latestBar } = require("../../../../lib/backtestDb.js") as {
  readCandles: (timeframe: string, start: string, end: string) => unknown[];
  upsertCandles: (timeframe: string, bars: unknown[], source?: string) => void;
  coverage: (timeframe: string) => { count: number; first: string | null; last: string | null; tradingDays: number };
  latestBar: (timeframe: string) => { timeKey?: string } | null;
};

const { isStale, lastClosedHkSessionDate, refreshTimeframeSingleFlight, runBridge } = require("../../../../lib/backtestRefresh.js") as {
  isStale: (timeKey?: string | null, timeframe?: string) => boolean;
  lastClosedHkSessionDate: () => string;
  refreshTimeframeSingleFlight: (timeframe: string, force?: boolean) => Promise<{ ok?: boolean; error?: string; latest?: { timeKey?: string } | null }>;
  runBridge: (start: string, end: string, timeframe: string) => Promise<{ ok?: boolean; bars?: unknown[]; error?: string; hint?: string }>;
};
const { dataPath } = dataPathsModule as unknown as { dataPath: (...segments: string[]) => string };
const { isPublicMode } = require("../../../../lib/publicMode.js") as { isPublicMode: () => boolean };

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;

type Payload = { ok?: boolean; bars?: unknown[]; error?: string; [key: string]: unknown };

function validDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(new Date(`${value}T00:00:00Z`).getTime());
}

export async function GET(request: NextRequest) {
  const end = request.nextUrl.searchParams.get("end") ?? new Date().toISOString().slice(0, 10);
  const days = Math.min(365, Math.max(7, Number(request.nextUrl.searchParams.get("days") ?? 180)));
  const timeframe = request.nextUrl.searchParams.get("timeframe") ?? "15m";
  const forceRefresh = !isPublicMode() && request.nextUrl.searchParams.get("refresh") === "1";
  if (!["1m", "15m", "4h", "1d"].includes(timeframe)) return NextResponse.json({ ok: false, error: "Invalid timeframe." }, { status: 400 });
  if (!validDate(end)) return NextResponse.json({ ok: false, error: "Invalid end date." }, { status: 400 });
  const endDate = new Date(`${end}T00:00:00Z`);
  const startDate = new Date(endDate.getTime() - days * 86_400_000);
  const start = startDate.toISOString().slice(0, 10);
  const closed = lastClosedHkSessionDate();
  const fetchEnd = end > closed ? closed : end;
  const cacheDir = dataPath(`backtest-${timeframe}-cache`);
  const cachePath = path.join(cacheDir, `${start}_${fetchEnd}.json`);
  const headers = { "Cache-Control": "no-store" };

  try {
    if (forceRefresh || isStale(latestBar(timeframe)?.timeKey, timeframe)) {
      await refreshTimeframeSingleFlight(timeframe, forceRefresh);
    }

    const stored = readCandles(timeframe, start, fetchEnd);
    if (stored.length) {
      const latest = latestBar(timeframe);
      return NextResponse.json({
        ok: true, symbol: "HK.HSImain", timeframe, start, end,
        bars: stored, count: stored.length, stored: true, storage: "backtest.sqlite",
        stale: isStale(latest?.timeKey, timeframe),
        latest,
        coverage: coverage(timeframe),
      }, { headers });
    }

    if (fs.existsSync(cachePath)) {
      const cached = JSON.parse(fs.readFileSync(cachePath, "utf8")) as Payload;
      if (cached.ok && Array.isArray(cached.bars) && cached.bars.length) {
        upsertCandles(timeframe, cached.bars, "existing-json-cache");
        const latest = latestBar(timeframe);
        return NextResponse.json({
          ...cached,
          cached: true,
          stored: true,
          stale: true,
          latest,
          storage: "backtest.sqlite",
        }, { headers });
      }
    }

    const payload = fetchEnd < start
      ? { ok: true, bars: [] }
      : await runBridge(start, fetchEnd, timeframe);
    if (payload.ok && Array.isArray(payload.bars)) {
      upsertCandles(timeframe, payload.bars, "futu-opend");
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(cachePath, JSON.stringify(payload));
    }
    const latest = latestBar(timeframe);
    return NextResponse.json({
      ...payload,
      stale: isStale(latest?.timeKey, timeframe),
      latest,
      stored: Boolean(payload.ok && payload.bars?.length),
      storage: "backtest.sqlite",
    }, { status: payload.ok ? 200 : 502, headers });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Backtest history failed." }, { status: 500, headers });
  }
}
