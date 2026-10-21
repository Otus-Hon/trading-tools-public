import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import dataPathsModule from "../../../../lib/dataPaths.js";
import pythonPathModule from "../../../../lib/pythonPath.js";
import publicModeModule from "../../../../lib/publicMode.js";
import futuDiskCacheModule from "../../../../lib/futuDiskCache.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type BridgePayload = {
  ok?: boolean;
  error?: string;
  suggestedDate?: string | null;
  [key: string]: unknown;
};

const { spawnPythonForHttp } = pythonPathModule as unknown as {
  spawnPythonForHttp: (args: string[]) => ReturnType<typeof import("node:child_process").spawn>;
};
const { isPublicMode } = publicModeModule as unknown as { isPublicMode: () => boolean };
const { readIntradayCache } = futuDiskCacheModule as unknown as {
  readIntradayCache: () => { at: number; payload: BridgePayload } | null;
};

function runBridge(): Promise<BridgePayload> {
  return new Promise((resolve, reject) => {
    const script = path.join(process.cwd(), "scripts", "futu_hsi_intraday.py");
    const child = spawnPythonForHttp([script]);
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

const { dataPath } = dataPathsModule as unknown as { dataPath: (...segments: string[]) => string };
const cachePath = dataPath("futu_hsi_intraday.json");
let cache: { at: number; payload: BridgePayload } | null = null;
let pending: Promise<BridgePayload> | null = null;
function validPayload(payload: BridgePayload) {
  return payload.ok && payload.symbol === "HK.800000" && payload.interval === "15m"
    && Array.isArray(payload.candles) && payload.candles.length >= 850;
}
try {
  const saved = JSON.parse(fs.readFileSync(cachePath, "utf8"));
  if (saved?.payload && validPayload(saved.payload)) cache = saved;
} catch {}

export async function GET() {
  if (isPublicMode()) {
    const saved = readIntradayCache() || cache;
    if (saved?.payload) {
      return NextResponse.json({ ...saved.payload, cached: true, stale: Date.now() - saved.at > 60_000 }, { headers: { "Cache-Control": "no-store" } });
    }
    return NextResponse.json({ ok: false, error: "No cached 15-minute HSI data is available yet." }, { status: 503 });
  }
  if (!cache || Date.now() - cache.at > 60_000) {
    pending ??= runBridge().then(payload => {
      if (!validPayload(payload)) throw new Error(payload.error || "Intraday feed unavailable");
      const next = { at: Date.now(), payload };
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      fs.writeFileSync(cachePath + ".tmp", JSON.stringify(next));
      fs.renameSync(cachePath + ".tmp", cachePath);
      cache = next;
      return payload;
    }).finally(() => { pending = null; });
    try { await pending; } catch {
      return NextResponse.json(cache ? { ...cache.payload, stale: true, error: "Intraday refresh failed." } : { ok: false, error: "Intraday refresh failed." }, { status: cache ? 200 : 502 });
    }
  }
  return NextResponse.json(cache!.payload, { headers: { "Cache-Control": "no-store" } });
}
