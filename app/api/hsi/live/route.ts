export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { fetchHsiLive } from "@/lib/hsiLive";

// Real-time HSI cash quote (price + intraday high/low) for the HSI panel's 5s poll
// and CBBC knockout detection. No DB, no cache — always the freshest tick.
export async function GET() {
  const live = await fetchHsiLive();
  if (live) {
    return NextResponse.json({ ok: true, ...live }, { headers: { "Cache-Control": "no-store" } });
  }
  return NextResponse.json(
    { ok: false, error: "HSI real-time feed unavailable" },
    { status: 502, headers: { "Cache-Control": "no-store" } }
  );
}
