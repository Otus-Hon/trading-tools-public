/* eslint-disable @typescript-eslint/no-require-imports */
import { spawn } from "node:child_process";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";

const { readCandles, listSessionDays } = require("../../../../lib/backtestDb.js") as {
  readCandles: (timeframe: string, start: string, end: string) => Array<{ timeKey?: string; time?: number }>;
  listSessionDays: (timeframe: string, limit: number, beforeDate?: string) => string[];
};
const { sessionDate } = require("../../../../lib/autoStrategies.js") as {
  sessionDate: (bar: { timeKey?: string }) => string;
};
const { pythonPath } = require("../../../../lib/pythonPath.js") as { pythonPath: () => string };
const { isPublicMode } = require("../../../../lib/publicMode.js") as { isPublicMode: () => boolean };

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;

function hktDate() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Hong_Kong", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

function shiftIsoDate(iso: string, days: number) {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function lastClosedHkSessionDate() {
  let date = shiftIsoDate(hktDate(), -1);
  let weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  while (weekday === 0 || weekday === 6) {
    date = shiftIsoDate(date, -1);
    weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  }
  return date;
}

function runPython(payload: unknown) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const child = spawn(pythonPath(), ["-u", path.join(process.cwd(), "scripts", "python_strategy_runner.py")], {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => child.kill("SIGTERM"), 180_000);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", () => {
      clearTimeout(timeout);
      const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        try { resolve(JSON.parse(lines[index]) as Record<string, unknown>); return; } catch { /* final JSON only */ }
      }
      reject(new Error(stderr.trim() || "Python strategy returned no JSON."));
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

export async function POST(request: NextRequest) {
  if (isPublicMode()) {
    return NextResponse.json({ ok: false, error: "Python strategy execution is disabled on the public website." }, { status: 403 });
  }
  try {
    const body = await request.json() as { code?: unknown; usdHkd?: unknown };
    if (typeof body.code !== "string") {
      return NextResponse.json({ ok: false, error: "code is required." }, { status: 400 });
    }
    const configResult = await runPython({ code: body.code, configOnly: true });
    if (!configResult.ok || !configResult.config || typeof configResult.config !== "object") {
      return NextResponse.json({ ok: false, error: typeof configResult.error === "string" ? configResult.error : "BACKTEST configuration is invalid." }, { status: 422 });
    }
    const config = configResult.config as { timeframe?: unknown; sessions?: unknown };
    const timeframe = typeof config.timeframe === "string" && ["1m", "15m", "4h", "1d"].includes(config.timeframe) ? config.timeframe : "1m";
    const sessions = Math.min(250, Math.max(1, Math.round(Number(config.sessions) || 15)));
    const closed = lastClosedHkSessionDate();
    const sessionDays = listSessionDays(timeframe, sessions, closed);
    const end = sessionDays[0];
    const start = sessionDays[sessionDays.length - 1];
    if (!start || !end) return NextResponse.json({ ok: false, error: `No stored ${timeframe} candles are available.` }, { status: 404 });
    const padStart = shiftIsoDate(start, -4);
    const stored = readCandles(timeframe, padStart, end);
    const wanted = new Set(sessionDays);
    const bars = stored.filter((bar) => wanted.has(sessionDate(bar)));
    if (!bars || bars.length < 30) {
      return NextResponse.json({ ok: false, error: "The selected SQL range needs at least 30 candles." }, { status: 400 });
    }
    if (body.code.length > 30_000 || bars.length > 2_000_000) {
      return NextResponse.json({ ok: false, error: "Strategy request is too large." }, { status: 413 });
    }
    const result = await runPython({
      code: body.code,
      bars,
      runtime: { usd_hkd: Number(body.usdHkd) || 7.8 },
    });
    return NextResponse.json({
      ...result,
      barCount: bars.length,
      bars: bars.length <= 250_000 ? bars : undefined,
      start,
      end,
      sessions: sessionDays.length || undefined,
      config: configResult.config,
      storage: "backtest.sqlite",
    }, { status: result.ok ? 200 : 422, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Python strategy failed." }, { status: 500 });
  }
}
