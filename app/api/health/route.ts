import { NextResponse } from "next/server";
import futuDiskCacheModule from "../../../lib/futuDiskCache.js";
import marketDbModule from "../../../lib/marketDb.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const futuCache = futuDiskCacheModule as unknown as {
  readFullCache: () => { at: number; payload: Record<string, unknown> } | null;
  readLiveCache: () => { at: number; payload: Record<string, unknown> } | null;
};
const marketDb = marketDbModule as unknown as {
  readMoneyFlowLong: () => { rows: unknown[] };
  readMoneyFlowShort: () => { rows: unknown[] };
  readOpenInterest: () => { rows: unknown[] };
};

export async function GET() {
  try {
    const full = futuCache.readFullCache();
    const live = futuCache.readLiveCache();
    const longRows = marketDb.readMoneyFlowLong().rows.length;
    const shortRows = marketDb.readMoneyFlowShort().rows.length;
    const openInterestRows = marketDb.readOpenInterest().rows.length;
    const liveAgeSeconds = live?.at ? Math.max(0, Math.round((Date.now() - live.at) / 1000)) : null;
    const ok = Boolean(full?.payload?.ok && live?.payload?.ok && longRows && shortRows && openInterestRows);

    return NextResponse.json({
      ok,
      status: ok ? "ready" : "warming",
      checks: {
        fullMarketCache: Boolean(full?.payload?.ok),
        liveMarketCache: Boolean(live?.payload?.ok),
        liveAgeSeconds,
        moneyFlowLongRows: longRows,
        moneyFlowShortRows: shortRows,
        openInterestRows,
      },
    }, { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ ok: false, status: "unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
