export const runtime = "nodejs";
import { NextRequest, NextResponse } from "next/server";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { saveMarketOrder, readMarketOrder } = require("@/lib/marketDb");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { isPublicMode } = require("@/lib/publicMode");

export async function GET() {
  const order: string[] = readMarketOrder();
  return NextResponse.json({ order });
}

export async function POST(req: NextRequest) {
  if (isPublicMode()) {
    return NextResponse.json({ error: "Shared market ordering is read-only on the public website." }, { status: 403 });
  }
  const body = await req.json() as { order?: string[] };
  if (!Array.isArray(body.order)) {
    return NextResponse.json({ error: "order must be an array" }, { status: 400 });
  }
  saveMarketOrder(body.order);
  return NextResponse.json({ ok: true });
}
