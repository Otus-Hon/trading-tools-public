import { NextResponse } from "next/server";

export const runtime = "nodejs";

const COOLDOWN_MS = 5_000;

let lastRun = 0;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { refreshCbbcSnapshot } = require("@/lib/cbbcSnapshot");

export async function POST() {
  const now = Date.now();
  if (now - lastRun < COOLDOWN_MS) {
    return NextResponse.json(
      { ok: false, error: "Too many requests, try again in a moment." },
      { status: 429, headers: { "Cache-Control": "no-store" } }
    );
  }
  lastRun = now;

  try {
    const payload = await refreshCbbcSnapshot();
    return NextResponse.json(
      {
        ok: true,
        fetched_at_utc: payload.fetched_at_utc,
        meta: payload.meta,
        counts: { bear: payload.bearRows.length, bull: payload.bullRows.length },
      },
      { status: 200, headers: { "Cache-Control": "no-store" } }
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const status = typeof (err as { status?: unknown })?.status === "number"
      ? ((err as { status: number }).status)
      : 500;
    const snippet = (err as { snippet?: unknown })?.snippet;
    return NextResponse.json(
      { ok: false, error: message || "Request failed", snippet },
      { status, headers: { "Cache-Control": "no-store" } }
    );
  }
}
