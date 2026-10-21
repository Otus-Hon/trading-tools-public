import { NextResponse } from "next/server";
import publicModeModule from "../../../../lib/publicMode.js";
import moneyFlowRefreshModule from "../../../../lib/moneyFlowRefresh.js";

export const runtime = "nodejs";

const { isPublicMode, publicForbiddenPayload } = publicModeModule as unknown as {
  isPublicMode: () => boolean;
  publicForbiddenPayload: (message?: string) => { ok: boolean; error: string };
};
const { refreshMoneyFlowHttp } = moneyFlowRefreshModule as unknown as {
  refreshMoneyFlowHttp: () => Promise<{ status: number; body: Record<string, unknown> }>;
};

export async function POST() {
  if (isPublicMode()) {
    return NextResponse.json(
      publicForbiddenPayload("Money-flow provider refresh is disabled on the public website."),
      { status: 403, headers: { "Cache-Control": "no-store" } }
    );
  }
  const result = await refreshMoneyFlowHttp();
  return NextResponse.json(result.body, { status: result.status, headers: { "Cache-Control": "no-store" } });
}
