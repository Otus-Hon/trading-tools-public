import { NextResponse } from "next/server";
import marketDbModule from "../../../../lib/marketDb.js";

export const runtime = "nodejs";

const marketDb = marketDbModule as unknown as { readMoneyFlowLong: () => { rows: unknown[]; meta: Record<string, unknown> } };

export async function GET() {
  const { rows, meta } = marketDb.readMoneyFlowLong();

  return NextResponse.json(
    {
      ok: true,
      fetched_at_utc: meta?.fetched_at_utc ?? null,
      source_url: meta?.source_url ?? null,
      meta,
      rows,
      row_count: rows.length,
      storage: "market.sqlite",
    },
    { status: 200, headers: { "Cache-Control": "no-store" } }
  );
}
