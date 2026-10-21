"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { diag, diagError } from "@/lib/clientDiag";

type CbbcRow = {
  side: string;
  start: number;
  end: number;
  count: number;
  change?: number | null;
};

type CbbcResponse = {
  ok?: boolean;
  error?: string;
  selectedDate?: string;
  fetched_at_utc?: string;
  meta?: {
    ulast?: number | string | null;
    hsilast?: number | string | null;
    sdate?: string | null;
    stime?: string | null;
    sumBull?: number | string | null;
    sumBear?: number | string | null;
  };
  bearRows?: CbbcRow[];
  bullRows?: CbbcRow[];
  todayHigh?: number | null;
  todayLow?: number | null;
  dayClose?: number | null;
  refreshError?: string | null;
  freshness?: {
    ageMs?: number;
    hkDate?: string;
    sourceUpdateDate?: string | null;
    outstandingDate?: string | null;
    isFreshFetch?: boolean;
    isCurrentSession?: boolean;
    isOutstandingToday?: boolean;
  };
};

type CbbcDateOption = {
  date: string;
  snapshotCount: number;
  latestFetchedAt: string;
};

const numberFormatter = new Intl.NumberFormat("en-US");

type ViewRow = CbbcRow & { hasLiveData: boolean };
type DisplayBucket = { start: number; end: number };

function formatRange(row: CbbcRow) {
  return `${numberFormatter.format(row.start)}-${numberFormatter.format(row.end)}`;
}

function formatDateLabel(date: string) {
  return date.replace(/-/g, "/");
}

function formatSnapshotTime(value: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return `${new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Hong_Kong",
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(parsed)} HKT`;
}

function buildDisplayBuckets(baseStart: number, direction: 1 | -1, count: number): DisplayBucket[] {
  const buckets: DisplayBucket[] = [];
  for (let i = 0; i < count; i += 1) {
    const start = baseStart + direction * i * 100;
    buckets.push({ start, end: start + 99 });
  }
  return buckets;
}

function mergeBucketsWithData(
  buckets: DisplayBucket[],
  liveMap: Map<number, CbbcRow>,
  side: "bear" | "bull"
): ViewRow[] {
  return buckets.map((bucket) => {
    const live = liveMap.get(bucket.start);
    if (live) {
      return { ...live, hasLiveData: true };
    }
    return {
      side,
      start: bucket.start,
      end: bucket.end,
      count: 0,
      change: null,
      hasLiveData: false,
    };
  });
}

type CbbcEchartsPanelProps = {
  refreshToken: number;
};

export default function CbbcEchartsPanel({ refreshToken }: CbbcEchartsPanelProps) {
  const [bearRows, setBearRows] = useState<CbbcRow[]>([]);
  const [bullRows, setBullRows] = useState<CbbcRow[]>([]);
  const [fetchedAt, setFetchedAt] = useState<string>("");
  const [meta, setMeta] = useState<CbbcResponse["meta"]>({});
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string>("");
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [freshness, setFreshness] = useState<CbbcResponse["freshness"]>(undefined);
  const [availableDates, setAvailableDates] = useState<CbbcDateOption[]>([]);
  const [selectedDate, setSelectedDate] = useState<string>("");
  const [snapshotHigh, setSnapshotHigh] = useState<number | null>(null);
  const [snapshotLow, setSnapshotLow] = useState<number | null>(null);
  const bearListRef = useRef<HTMLDivElement | null>(null);
  const requestIdRef = useRef(0);

  // Real-time HSI cash feed — drives the current price and the knockout coloring,
  // replacing the once-daily frozen CBBC snapshot (meta.ulast / todayHigh / todayLow).
  const [liveSpot, setLiveSpot] = useState<number | null>(null);
  const [liveHigh, setLiveHigh] = useState<number | null>(null);
  const [liveLow, setLiveLow] = useState<number | null>(null);
  const [liveStale, setLiveStale] = useState<boolean>(false);

  const fetchData = useCallback(async (date: string) => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError("");
    try {
      const url = date
        ? `/api/cbbc/history?date=${encodeURIComponent(date)}`
        : "/api/cbbc/latest";
      const res = await fetch(url, { cache: "no-store" });
      const data = (await res.json()) as CbbcResponse;
      if (!res.ok || data.ok === false) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      if (requestId !== requestIdRef.current) return;
      setBearRows(Array.isArray(data.bearRows) ? data.bearRows : []);
      setBullRows(Array.isArray(data.bullRows) ? data.bullRows : []);
      setFetchedAt(data.fetched_at_utc || "");
      setMeta(data.meta || {});
      setRefreshError(data.refreshError || null);
      setFreshness(date ? undefined : data.freshness);
      setSnapshotHigh(typeof data.todayHigh === "number" ? data.todayHigh : null);
      setSnapshotLow(typeof data.todayLow === "number" ? data.todayLow : null);
      diag("CBBC", "fetch success", {
        status: res.status,
        selectedDate: date || "latest",
        fetchedAt: data.fetched_at_utc || "",
        bearRows: Array.isArray(data.bearRows) ? data.bearRows.length : 0,
        bullRows: Array.isArray(data.bullRows) ? data.bullRows.length : 0,
        meta: data.meta || {},
      });
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      setError(err instanceof Error ? err.message : "Failed to load CBBC data");
      setBearRows([]);
      setBullRows([]);
      setRefreshError(null);
      setFreshness(undefined);
      setSnapshotHigh(null);
      setSnapshotLow(null);
      diagError("CBBC", "fetch failed", err);
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchData(selectedDate);
  }, [fetchData, refreshToken, selectedDate]);

  useEffect(() => {
    let cancelled = false;
    const fetchDates = async () => {
      try {
        const res = await fetch("/api/cbbc/history", { cache: "no-store" });
        const data = (await res.json()) as { ok?: boolean; dates?: CbbcDateOption[] };
        if (!cancelled && res.ok && Array.isArray(data.dates)) setAvailableDates(data.dates);
      } catch (err) {
        diagError("CBBC", "date list fetch failed", err);
      }
    };
    void fetchDates();
    return () => { cancelled = true; };
  }, [refreshToken]);

  // Poll the real-time HSI cash feed every 5s for the live spot + intraday high/low.
  useEffect(() => {
    if (selectedDate) {
      setLiveSpot(null);
      setLiveHigh(null);
      setLiveLow(null);
      setLiveStale(false);
      return;
    }
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch("/api/hsi/live", { cache: "no-store" });
        if (!res.ok) { if (!cancelled) setLiveStale(true); return; }
        const j = (await res.json()) as {
          ok?: boolean; price?: number; high?: number | null; low?: number | null; realtime?: boolean;
        };
        if (cancelled) return;
        if (!j.ok || typeof j.price !== "number" || !Number.isFinite(j.price)) { setLiveStale(true); return; }
        setLiveStale(!j.realtime);
        setLiveSpot(j.price);
        setLiveHigh(typeof j.high === "number" ? j.high : null);
        setLiveLow(typeof j.low === "number" ? j.low : null);
      } catch {
        if (!cancelled) setLiveStale(true);
      }
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => { cancelled = true; clearInterval(id); };
  }, [selectedDate]);

  const snapshotIndex = useMemo(() => {
    // Historical hsilast is the selected market day's close; ulast may be the
    // following fetch session's live value. Latest mode keeps ulast as its fallback.
    const raw = selectedDate ? (meta?.hsilast ?? meta?.ulast) : (meta?.ulast ?? meta?.hsilast);
    if (raw === null || raw === undefined) return null;
    const num = typeof raw === "string" ? Number(raw.replace(/,/g, "")) : Number(raw);
    return Number.isFinite(num) ? num : null;
  }, [meta, selectedDate]);

  // Live cash spot, falling back to the date-appropriate frozen snapshot.
  const spot = !selectedDate && liveSpot !== null ? liveSpot : snapshotIndex;

  const activeHigh = selectedDate ? snapshotHigh : (liveHigh ?? snapshotHigh);
  const activeLow = selectedDate ? snapshotLow : (liveLow ?? snapshotLow);

  // Build maps for lookup
  const liveBearMap = useMemo(() => {
    const m = new Map<number, CbbcRow>();
    (Array.isArray(bearRows) ? bearRows : [])
      .filter((r) => r.side === "bear" && r.end - r.start === 99)
      .forEach((r) => m.set(r.start, r));
    return m;
  }, [bearRows]);

  const liveBullMap = useMemo(() => {
    const m = new Map<number, CbbcRow>();
    (Array.isArray(bullRows) ? bullRows : [])
      .filter((r) => r.side === "bull" && r.end - r.start === 99)
      .forEach((r) => m.set(r.start, r));
    return m;
  }, [bullRows]);

  const baseBucketStart = useMemo(() => {
    if (spot === null) return 0;
    return Math.floor(spot / 100) * 100;
  }, [spot]);

  const bearDisplay = useMemo(() => {
    const liveRows = (Array.isArray(bearRows) ? bearRows : [])
      .filter((r) => r.side === "bear" && r.end - r.start === 99)
      .sort((a, b) => b.start - a.start)
      .map((row) => ({ ...row, hasLiveData: true }));

    if (liveRows.length > 0) return liveRows;

    const buckets = buildDisplayBuckets(baseBucketStart, 1, 10);
    return mergeBucketsWithData(buckets, liveBearMap, "bear").reverse();
  }, [baseBucketStart, bearRows, liveBearMap]);

  const bullDisplay = useMemo(() => {
    const liveRows = (Array.isArray(bullRows) ? bullRows : [])
      .filter((r) => r.side === "bull" && r.end - r.start === 99)
      .sort((a, b) => b.start - a.start)
      .map((row) => ({ ...row, hasLiveData: true }));

    if (liveRows.length > 0) return liveRows;

    const buckets = buildDisplayBuckets(baseBucketStart, -1, 10);
    return mergeBucketsWithData(buckets, liveBullMap, "bull");
  }, [baseBucketStart, bullRows, liveBullMap]);

  useEffect(() => {
    if (!loading && !error && bearListRef.current) {
      bearListRef.current.scrollTop = bearListRef.current.scrollHeight;
    }
  }, [loading, error, bearDisplay.length]);

  const maxBear = Math.max(...bearDisplay.filter((r) => r.hasLiveData).map((r) => r.count || 0), 1);
  const maxBull = Math.max(...bullDisplay.filter((r) => r.hasLiveData).map((r) => r.count || 0), 1);
  const heavyBear = Math.max(...bearDisplay.filter((r) => r.hasLiveData).map((r) => r.count || 0), 0);
  const heavyBull = Math.max(...bullDisplay.filter((r) => r.hasLiveData).map((r) => r.count || 0), 0);
  const heavyBearStarts = bearDisplay
    .filter((r) => r.hasLiveData && r.count === heavyBear && (r.count || 0) > 0)
    .map((r) => r.start);
  const heavyBullStarts = bullDisplay
    .filter((r) => r.hasLiveData && r.count === heavyBull && (r.count || 0) > 0)
    .map((r) => r.start);
  const mostNewBear = Math.max(...bearDisplay.filter((r) => r.hasLiveData).map((r) => r.change || 0), 0);
  const mostNewBull = Math.max(...bullDisplay.filter((r) => r.hasLiveData).map((r) => r.change || 0), 0);

  const renderRow = (
    row: ViewRow,
    color: string,
    maxCount: number,
    heavyStarts: number[],
    mostNewVal: number,
    sideLabel: string,
    isKnockedOut = false
  ) => {
    if (!row.hasLiveData) {
      return null;
    }

    const hasValue = row.count !== undefined && row.count > 0;
    const pct = hasValue && maxCount > 0 ? Math.min(100, (row.count / maxCount) * 100) : 0;
    const isHeavy = hasValue && heavyStarts.includes(row.start);
    const isMostNew = hasValue && mostNewVal > 0 && row.change === mostNewVal;
    const change = row.change ?? null;
    const barBg = "bg-[rgba(0,0,0,0.08)]";
    const fillColor = isKnockedOut ? "#9e9e9e" : color;

    return (
      <div
        key={`${row.side}-${row.start}-${row.end}-${row.count ?? 0}`}
        className="grid grid-cols-[108px,1fr,60px] items-center gap-[1px] text-[10px]"
        style={{ minHeight: "12px" }}
      >
        <div className="font-medium text-[var(--text)]">{formatRange(row)}</div>
        <div className="flex items-center gap-[2px]">
          <div className={`relative h-[7px] flex-1 rounded-full ${barBg}`}>
            <div
              className="absolute inset-y-0 left-0 rounded-full"
              style={{ width: `${pct}%`, background: fillColor }}
            />
            {isHeavy && (
              <span className="absolute left-1 top-1/2 -translate-y-1/2 rounded-sm bg-white/80 px-1 text-[10px] font-semibold text-[var(--text)] shadow-sm">
                重貨區
              </span>
            )}
          </div>
          <div className="flex items-center gap-0.5 text-[10px] text-[var(--text)]">
            <span className={`font-semibold ${hasValue ? "" : "text-[var(--muted)]"}`}>
              {hasValue ? numberFormatter.format(row.count || 0) : "—"}
            </span>
            {hasValue && (
              <span
                className={
                  change === null || change === 0
                    ? "text-[var(--muted)]"
                    : change > 0
                      ? "text-green-700"
                      : "text-red-600"
                }
              >
                [{change !== null && change > 0 ? "+" : ""}{change ?? 0}]
              </span>
            )}
            {isMostNew && (
              <span className="rounded-sm bg-orange-100 px-1 text-[9px] font-semibold text-orange-700">
                ▲ 最多新增
              </span>
            )}
          </div>
        </div>
        <div className="text-[10px] font-semibold text-[var(--text)]">{sideLabel}</div>
      </div>
    );
  };

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-[var(--border)] pb-2">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <h2 className="text-xs font-semibold text-[var(--text)]">
              CBBC Outstanding ({selectedDate ? formatDateLabel(selectedDate) : "Latest"})
            </h2>
            {selectedDate && (
              <span className="rounded-full bg-sky-100 px-1.5 py-0.5 text-[8px] font-semibold uppercase tracking-wide text-sky-700">
                Historical
              </span>
            )}
          </div>
          <div className="flex shrink-0 items-end gap-1.5">
            <label className="flex flex-col gap-0.5 text-[8px] font-semibold uppercase tracking-wide text-[var(--muted)]">
              CBBC date
              <select
                aria-label="Select saved CBBC date"
                value={selectedDate}
                onChange={(event) => setSelectedDate(event.target.value)}
                className="h-7 max-w-[125px] rounded-md border border-[var(--border)] bg-[var(--card)] px-2 text-[10px] font-semibold text-[var(--text)] outline-none transition focus:border-sky-500 focus:ring-2 focus:ring-sky-100"
              >
                <option value="">Latest available</option>
                {availableDates.map((option) => (
                  <option key={option.date} value={option.date}>
                    {formatDateLabel(option.date)}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              onClick={() => setSelectedDate("")}
              disabled={!selectedDate || loading}
              title="Show today's latest available CBBC data"
              className="h-7 rounded-md border border-[var(--border)] bg-[var(--card)] px-2 text-[9px] font-semibold text-[var(--text)] shadow-sm transition hover:border-sky-300 hover:bg-sky-50 disabled:cursor-default disabled:opacity-40"
            >
              Today
            </button>
          </div>
        </div>
        <div className="mt-1 min-w-0">
          <div className="text-[9px] text-[var(--muted)]">
            {fetchedAt
              ? `${selectedDate ? "Saved" : "Fetched"}: ${formatSnapshotTime(fetchedAt)}`
              : ""}
          </div>
          {(meta?.sdate || meta?.stime || snapshotIndex !== null) && (
            <div className="text-[9px] text-[var(--muted)]">
              {meta?.sdate ? `Market date: ${meta.sdate}` : ""} {meta?.stime ? `Time: ${meta.stime}` : ""}{" "}
              {snapshotIndex !== null ? `Index: ${snapshotIndex}` : ""}
            </div>
          )}
          {freshness?.outstandingDate && freshness.isOutstandingToday === false && (
            <div className="text-[9px] font-medium text-amber-700">
              Outstanding date: {freshness.outstandingDate}; source update: {freshness.sourceUpdateDate || "unknown"}
            </div>
          )}
          {refreshError && (
            <div className="text-[9px] font-medium text-red-600">
              Refresh failed: {refreshError}
            </div>
          )}
          {spot !== null && (
            <div className="flex items-center gap-1 text-[9px]">
              <span
                className={`inline-block h-1.5 w-1.5 rounded-full ${
                  selectedDate
                    ? "bg-sky-500"
                    : liveSpot === null || liveStale
                      ? "bg-amber-500"
                      : "bg-emerald-500 animate-pulse"
                }`}
              />
              <span className="font-semibold text-[var(--text)]">
                {selectedDate
                  ? "Snapshot"
                  : liveSpot === null
                    ? "Snapshot"
                    : liveStale
                      ? "Stale"
                      : "Live"} HSI:{" "}
                {spot.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
            </div>
          )}
        </div>
      </div>

      <div className="mt-1 space-y-1">
        {loading && <div className="text-[10px] text-[var(--muted)]">Loading...</div>}
        {!loading && error && <div className="text-[10px] font-medium text-red-600">Error: {error}</div>}
        {!loading && !error && bearRows.length === 0 && bullRows.length === 0 && (
          <div className="text-[10px] text-[var(--muted)]">No data</div>
        )}
        {!loading && !error && (bearRows.length > 0 || bullRows.length > 0) && (
          <div className="flex flex-col gap-1">
            <div
              ref={bearListRef}
              className="space-y-0.5 overflow-y-auto rounded-md bg-[rgba(0,0,0,0.02)] p-1"
              style={{ maxHeight: "150px" }}
            >
              <div className="text-[10px] font-semibold uppercase tracking-wide text-[var(--text)]">Bear (100-point)</div>
              {bearDisplay.length === 0 ? (
                <div className="text-[10px] text-[var(--muted)]">No outstanding in this window</div>
              ) : (
                <div className="flex flex-col gap-0.5">
                  {bearDisplay.map((row) => renderRow(row, "#c62828", maxBear, heavyBearStarts, mostNewBear, "", activeHigh !== null && activeHigh >= row.end + 1))}
                </div>
              )}
            </div>

            <div className="rounded-md bg-[rgba(0,0,0,0.03)] px-2 py-[6px] text-center text-[10px] font-semibold text-[var(--text)]">
              {!selectedDate && liveSpot !== null && !liveStale ? "現價" : selectedDate ? "歷史指數" : "市場"}:{" "}
              {spot !== null ? spot.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—"}
            </div>

            <div className="space-y-0.5 overflow-y-auto rounded-md bg-[rgba(0,0,0,0.02)] p-1" style={{ maxHeight: "150px" }}>
              <div className="text-[10px] font-semibold uppercase tracking-wide text-[var(--text)]">Bull (100-point)</div>
              {bullDisplay.length === 0 ? (
                <div className="text-[10px] text-[var(--muted)]">No outstanding in this window</div>
              ) : (
                <div className="flex flex-col gap-0.5">
                  {bullDisplay.map((row) => renderRow(row, "#148c3c", maxBull, heavyBullStarts, mostNewBull, "", activeLow !== null && activeLow <= row.start - 1))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
