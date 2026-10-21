import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import pythonPathModule from "../../../../lib/pythonPath.js";
import publicModeModule from "../../../../lib/publicMode.js";
import futuDiskCacheModule from "../../../../lib/futuDiskCache.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Payload = { ok?: boolean; error?: string; [key: string]: unknown };

let fullCache: { at: number; payload: Payload } | null = null;
let liveCache: { at: number; payload: Payload } | null = null;
let cbbcCache: { at: number; payload: Payload } | null = null;
let fullRefreshInFlight: Promise<Payload> | null = null;
let cbbcRefreshInFlight: Promise<Payload> | null = null;
const { spawnPythonForHttp } = pythonPathModule as unknown as {
  spawnPythonForHttp: (args: string[], options?: Record<string, unknown>) => ReturnType<typeof import("node:child_process").spawn>;
};
const { isPublicMode } = publicModeModule as unknown as { isPublicMode: () => boolean };
const futuDiskCache = futuDiskCacheModule as unknown as {
  EXPIRY_SELECTION_POLICY: string;
  readFullCache: () => { at: number; payload: Payload } | null;
  readLiveCache: () => { at: number; payload: Payload } | null;
  writeFullCache: (cache: { at: number; payload: Payload }) => void;
  persistFutuOpenInterest: (payload: Payload) => void;
};
const EXPIRY_SELECTION_POLICY = futuDiskCache.EXPIRY_SELECTION_POLICY;

try {
  const saved = futuDiskCache.readFullCache();
  if (saved?.payload?.ok) {
    fullCache = saved;
    if (
      saved.payload.cbbcComplete === true &&
      Number(saved.payload.cbbcRowsFetched) === Number(saved.payload.cbbcTotal) &&
      Array.isArray(saved.payload.cbbcLevels)
    ) {
      cbbcCache = saved;
    }
  }
} catch {
  // First run has no persistent cache.
}

function saveFullCache(cache: { at: number; payload: Payload }) {
  try {
    futuDiskCache.writeFullCache(cache);
  } catch {
    // Memory caching remains available.
  }
}

function cachedFallback(error: string, liveOnly: boolean): Payload | null {
  if (!fullCache?.payload.ok) return null;

  return {
    ...fullCache.payload,
    cached: true,
    stale: true,
    liveOnly,
    liveUnavailable: liveOnly,
    refreshError: error,
  };
}

function persistOpenInterest(payload: Payload) {
  futuDiskCache.persistFutuOpenInterest(payload);
}

function runBridge(liveOnly: boolean, cbbcOnly = false): Promise<Payload> {
  return new Promise((resolve, reject) => {
    const script = path.join(process.cwd(), "scripts", "futu_market_data.py");
    const args = [
      script,
      ...(cbbcOnly ? ["--cbbc-only"] : ["--skip-cbbc", ...(liveOnly ? ["--live-only"] : [])]),
    ];
    const child = spawnPythonForHttp(args);
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
          resolve(JSON.parse(lines[index]) as Payload);
          return;
        } catch {
          // Futu connection logs surround the JSON payload.
        }
      }
      reject(new Error(stderr.trim() || stdout.trim() || "Futu market-data bridge returned no JSON."));
    });
  });
}

function mergeVerifiedCbbc(payload: Payload): Payload {
  if (!cbbcCache?.payload.ok) return payload;
  const cbbc = cbbcCache.payload;
  return {
    ...payload,
    cbbcLevels: cbbc.cbbcLevels,
    cbbcTotal: cbbc.cbbcTotal,
    cbbcActive: cbbc.cbbcActive,
    cbbcRowsFetched: cbbc.cbbcRowsFetched,
    cbbcComplete: cbbc.cbbcComplete,
    cbbcFetchedAt: cbbc.cbbcFetchedAt,
  };
}

function ensureCbbcRefresh(now: number): Promise<Payload> | null {
  if (cbbcCache?.payload.ok && now - cbbcCache.at < 4_000) return null;
  if (!cbbcRefreshInFlight) {
    cbbcRefreshInFlight = runBridge(false, true)
      .then((payload) => {
        if (
          payload.ok &&
          payload.cbbcComplete === true &&
          Number(payload.cbbcRowsFetched) === Number(payload.cbbcTotal) &&
          Array.isArray(payload.cbbcLevels)
        ) {
          cbbcCache = { at: Date.now(), payload };
          if (fullCache?.payload.ok) {
            fullCache = { ...fullCache, payload: mergeVerifiedCbbc(fullCache.payload) };
            saveFullCache(fullCache);
          }
        }
        return payload;
      })
      .catch((error) => ({
        ok: false,
        error: error instanceof Error ? error.message : "Futu CBBC refresh failed.",
      }))
      .finally(() => { cbbcRefreshInFlight = null; });
  }
  return cbbcRefreshInFlight;
}

export async function GET(request: NextRequest) {
  const liveOnly = request.nextUrl.searchParams.get("live") === "1";
  if (isPublicMode()) {
    const cached = liveOnly ? futuDiskCache.readLiveCache() : futuDiskCache.readFullCache();
    if (cached?.payload) {
      return NextResponse.json(
        { ...cached.payload, cached: true },
        { headers: { "Cache-Control": "no-store" } }
      );
    }
    return NextResponse.json(
      { ok: false, error: "No cached Futu market data is available yet." },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }
  const forceRefresh = request.nextUrl.searchParams.get("refresh") === "1";
  const now = Date.now();
  const cbbcRefresh = ensureCbbcRefresh(now);
  if (!cbbcCache && cbbcRefresh) await cbbcRefresh;
  const cache = liveOnly ? liveCache : fullCache;
  const ttl = liveOnly ? 4_000 : 60_000;
  if (!forceRefresh && cache?.payload.ok && now - cache.at < ttl) {
    return NextResponse.json(mergeVerifiedCbbc(cache.payload), { headers: { "Cache-Control": "no-store" } });
  }

  if (!forceRefresh && !liveOnly && fullCache?.payload.ok) {
    if (!fullRefreshInFlight) {
      fullRefreshInFlight = runBridge(false)
        .then((payload) => {
          if (payload.ok) {
            persistOpenInterest(payload);
            const next = { at: Date.now(), payload: mergeVerifiedCbbc(payload) };
            fullCache = next;
            saveFullCache(next);
          }
          return payload;
        })
        .catch((error) => ({
          ok: false,
          error: error instanceof Error ? error.message : "Futu market-data refresh failed.",
        }))
        .finally(() => { fullRefreshInFlight = null; });
    }
    return NextResponse.json(mergeVerifiedCbbc({ ...fullCache.payload, cached: true }), { headers: { "Cache-Control": "no-store" } });
  }

  try {
    const payload = await runBridge(liveOnly);
    if (payload.ok) {
      persistOpenInterest(payload);
      if (liveOnly) {
        liveCache = { at: now, payload };
        try {
          (futuDiskCacheModule as { writeLiveCache: (cache: { at: number; payload: Payload }) => void }).writeLiveCache({ at: now, payload });
        } catch {
          // Memory caching remains available.
        }
      }
      else {
        fullCache = { at: now, payload: mergeVerifiedCbbc(payload) };
        saveFullCache(fullCache);
      }
    } else {
      const fallback = cachedFallback(payload.error || "Futu OpenD is unavailable.", liveOnly);
      if (fallback) {
        return NextResponse.json(mergeVerifiedCbbc(fallback), { headers: { "Cache-Control": "no-store" } });
      }
    }
    return NextResponse.json(mergeVerifiedCbbc(payload), {
      status: payload.ok ? 200 : 502,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Futu market-data bridge failed.";
    const fallback = cachedFallback(message, liveOnly);
    if (fallback) {
      return NextResponse.json(mergeVerifiedCbbc(fallback), { headers: { "Cache-Control": "no-store" } });
    }
    return NextResponse.json(
      { ok: false, error: message },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
