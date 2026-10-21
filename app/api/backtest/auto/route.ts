/* eslint-disable @typescript-eslint/no-require-imports */
import { NextRequest, NextResponse } from "next/server";

const { readCandles, coverage, latestBar, listTradingDays } = require("../../../../lib/backtestDb.js") as {
  readCandles: (timeframe: string, start: string, end: string) => unknown[];
  coverage: (timeframe: string) => { count: number; first: string | null; last: string | null; tradingDays: number };
  latestBar: (timeframe: string) => { timeKey?: string } | null;
  listTradingDays: (timeframe: string, limit: number) => string[];
};
const { isStale, lastClosedHkSessionDate, refreshTimeframeSingleFlight } = require("../../../../lib/backtestRefresh.js") as {
  isStale: (timeKey?: string | null) => boolean;
  lastClosedHkSessionDate: () => string;
  refreshTimeframeSingleFlight: (timeframe: string, force?: boolean) => Promise<{ ok?: boolean; error?: string }>;
};
const { runAutoStrategies } = require("../../../../lib/autoStrategies.js") as {
  runAutoStrategies: (bars: unknown[], options: { days: number; rewardRisk: number }) => Record<string, unknown>;
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;

export async function GET(request: NextRequest) {
  const days = Math.min(120, Math.max(1, Math.round(Number(request.nextUrl.searchParams.get("days") ?? 10) || 10)));
  const rewardRisk = Math.min(10, Math.max(0.5, Number(request.nextUrl.searchParams.get("rewardRisk") ?? 2) || 2));
  const forceRefresh = request.nextUrl.searchParams.get("refresh") === "1";
  const headers = { "Cache-Control": "no-store" };

  try {
    if (forceRefresh) {
      await refreshTimeframeSingleFlight("1m", true);
    } else if (isStale(latestBar("1m")?.timeKey)) {
      // Render the last verified SQLite history immediately while the missing
      // closed-session tail refreshes in the background. OpenD may be absent
      // in a public deployment, which must not hide stored backtest results.
      void refreshTimeframeSingleFlight("1m", false);
    }
    const closed = lastClosedHkSessionDate();
    const recentDays = listTradingDays("1m", days + 14).filter((day) => day <= closed);
    if (recentDays.length < 1) {
      return NextResponse.json({
        ok: false,
        error: "Need at least one stored HK.HSImain 1m session. Use Refresh data on the Backtest page.",
        coverage: coverage("1m"),
      }, { status: 404, headers });
    }
    const end = recentDays[0];
    const startDate = new Date(`${recentDays[recentDays.length - 1]}T00:00:00Z`);
    startDate.setUTCDate(startDate.getUTCDate() - 4);
    const start = startDate.toISOString().slice(0, 10);
    const bars = readCandles("1m", start, end);
    const result = runAutoStrategies(bars, { days, rewardRisk });
    const latest = latestBar("1m");
    return NextResponse.json({
      ...result,
      requestedDays: days,
      barCount: bars.length,
      stale: isStale(latest?.timeKey),
      latest,
      coverage: coverage("1m"),
      storage: "backtest.sqlite",
    }, { headers });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : "Auto strategy backtest failed.",
    }, { status: 500, headers });
  }
}
