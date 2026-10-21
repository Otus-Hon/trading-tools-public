/* eslint-disable @typescript-eslint/no-require-imports */
import { NextRequest, NextResponse } from "next/server";

const { TIMEFRAMES, refreshBacktestHistories } = require("../../../../lib/backtestRefresh.js") as {
  TIMEFRAMES: string[];
  refreshBacktestHistories: (timeframes?: string[], force?: boolean) => Promise<Record<string, unknown>>;
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({})) as { timeframe?: unknown; timeframes?: unknown; force?: unknown };
    const requested = Array.isArray(body.timeframes)
      ? body.timeframes.filter((item): item is string => typeof item === "string")
      : typeof body.timeframe === "string"
        ? [body.timeframe]
        : TIMEFRAMES;
    const payload = await refreshBacktestHistories(requested, body.force === true);
    return NextResponse.json(payload, {
      status: payload.ok ? 200 : 502,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : "Backtest history refresh failed.",
    }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
