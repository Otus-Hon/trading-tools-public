import { spawn } from "node:child_process";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import pythonPathModule from "../../../../lib/pythonPath.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type BridgePayload = {
  ok?: boolean;
  error?: string;
  suggestedDate?: string | null;
  [key: string]: unknown;
};

function defaultBacktestDate() {
  const date = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Hong_Kong",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function isValidIsoDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

const { pythonPath } = pythonPathModule as unknown as { pythonPath: () => string };

function runBridge(date: string): Promise<BridgePayload> {
  return new Promise((resolve, reject) => {
    const script = path.join(process.cwd(), "scripts", "futu_candles.py");
    const child = spawn(pythonPath(), ["-u", script, "--date", date], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => child.kill("SIGTERM"), 60_000);

    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", () => {
      clearTimeout(timeout);
      const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        try {
          const parsed = JSON.parse(lines[index]) as BridgePayload;
          resolve(parsed);
          return;
        } catch {
          // Futu emits connection logs before the bridge's final JSON line.
        }
      }
      reject(new Error(stderr.trim() || stdout.trim() || "Futu bridge returned no JSON response."));
    });
  });
}

export async function GET(request: NextRequest) {
  const date = request.nextUrl.searchParams.get("date") || defaultBacktestDate();
  if (!isValidIsoDate(date)) {
    return NextResponse.json(
      { ok: false, error: "Date must use YYYY-MM-DD format." },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }

  try {
    const payload = await runBridge(date);
    return NextResponse.json(payload, {
      status: payload.ok ? 200 : payload.suggestedDate ? 422 : 502,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Futu bridge failed." },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
