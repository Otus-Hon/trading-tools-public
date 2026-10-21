"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { diag, diagError } from "@/lib/clientDiag";
import { CandlestickSeries, ColorType, CrosshairMode, createChart } from "lightweight-charts";

type Quote = {
  symbol: string;
  label: string;
  price: number | null;
  change: number | null;
  changePercent: number | null;
};

type ApiResponse = { updatedAt: string; quotes: Quote[] };
type Candle = { time: string; open: number | null; high: number | null; low: number | null; close: number | null };
type ChartResponse = { symbol: string; interval: string; candles: Candle[] };
type FetchStatus = "idle" | "fetching" | "success" | "error";

const chartCache = new Map<string, Candle[]>();
const DAILY_INTERVAL = "1d";

const LOADING = (
  <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-gray-300 border-t-gray-500" />
);

function fmt(value: number | null | undefined, decimals = 2): React.ReactNode {
  if (value == null || !Number.isFinite(value)) return LOADING;
  return value.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}
function fmtChg(value: number | null | undefined): React.ReactNode {
  if (value == null || !Number.isFinite(value)) return LOADING;
  return (value >= 0 ? "+" : "") + value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtPct(value: number | null | undefined): React.ReactNode {
  if (value == null || !Number.isFinite(value)) return LOADING;
  return (value >= 0 ? "+" : "") + value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + "%";
}

export default function MarketDashboard() {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fetchStatus, setFetchStatus] = useState<FetchStatus>("idle");
  const [order, setOrder] = useState<string[]>([]);
  const [selectedSymbol, setSelectedSymbol] = useState<{ symbol: string; label: string } | null>(null);
  const [chartCandles, setChartCandles] = useState<Candle[] | null>(null);
  const [chartLoading, setChartLoading] = useState(false);
  const miniChartRef = useRef<HTMLDivElement>(null);
  const dragSymbol = useRef<string | null>(null);
  const statusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevPrices = useRef<Map<string, number>>(new Map());
  const [flashMap, setFlashMap] = useState<Map<string, "up" | "dn">>(new Map());

  // Load saved order from DB
  useEffect(() => {
    fetch("/api/markets/order")
      .then(r => r.json())
      .then((j: { order: string[] }) => { if (j.order?.length) setOrder(j.order); })
      .catch(() => {});
  }, []);

  const setStatus = useCallback((s: FetchStatus) => {
    setFetchStatus(s);
    if (statusTimer.current) clearTimeout(statusTimer.current);
    if (s === "success" || s === "error") {
      statusTimer.current = setTimeout(() => setFetchStatus("idle"), 1500);
    }
  }, []);

  const fetchData = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) { setLoading(true); setError(null); }
    setStatus("fetching");
    try {
      const res = await fetch("/api/markets", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as ApiResponse;
      // Detect price changes and flash affected rows
      const changed = new Map<string, "up" | "dn">();
      for (const q of json.quotes) {
        if (q.price == null) continue;
        const prev = prevPrices.current.get(q.symbol);
        if (prev != null && prev !== q.price) {
          changed.set(q.symbol, q.price > prev ? "up" : "dn");
        }
        prevPrices.current.set(q.symbol, q.price);
      }
      if (changed.size > 0) {
        setFlashMap(changed);
        setTimeout(() => setFlashMap(new Map()), 600);
      }
      setData(json);
      setOrder(prev => {
        const symbols = json.quotes.map(q => q.symbol);
        if (prev.length > 0) {
          const valid = prev.filter(s => symbols.includes(s));
          const missing = symbols.filter(s => !prev.includes(s));
          return [...valid, ...missing];
        }
        return symbols;
      });
      setStatus("success");
      diag("Markets", "fetch ok", { quotes: json.quotes?.length });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
      setStatus("error");
      diagError("Markets", "fetch failed", err);
    } finally {
      if (!opts?.silent) setLoading(false);
    }
  }, [setStatus]);

  // Background preload charts
  const preload = useCallback((quotes: Quote[]) => {
    for (const q of quotes) {
      const key = `${q.symbol}::${DAILY_INTERVAL}`;
      if (!chartCache.has(key)) {
        fetch(`/api/markets/chart?symbol=${encodeURIComponent(q.symbol)}&interval=${DAILY_INTERVAL}`, { cache: "no-store" })
          .then(r => r.json()).then((j: ChartResponse) => { chartCache.set(key, j.candles ?? []); }).catch(() => {});
      }
    }
  }, []);

  useEffect(() => {
    fetchData();
    const id = setInterval(() => fetchData({ silent: true }), 3_000);
    return () => clearInterval(id);
  }, [fetchData]);

  useEffect(() => { if (data?.quotes?.length) preload(data.quotes); }, [data, preload]);

  // ESC closes popup
  useEffect(() => {
    if (!selectedSymbol) return;
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") setSelectedSymbol(null); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [selectedSymbol]);

  // Fetch chart when symbol/interval selected
  useEffect(() => {
    if (!selectedSymbol) { setChartCandles(null); return; }
    const key = `${selectedSymbol.symbol}::${DAILY_INTERVAL}`;
    const cached = chartCache.get(key);
    if (cached) { setChartCandles(cached); return; }
    let cancelled = false;
    setChartLoading(true);
    setChartCandles(null);
    fetch(`/api/markets/chart?symbol=${encodeURIComponent(selectedSymbol.symbol)}&interval=${DAILY_INTERVAL}`, { cache: "no-store" })
      .then(r => r.json()).then((j: ChartResponse) => {
        if (!cancelled) { chartCache.set(key, j.candles ?? []); setChartCandles(j.candles ?? []); }
      }).catch(() => { if (!cancelled) setChartCandles([]); })
      .finally(() => { if (!cancelled) setChartLoading(false); });
    return () => { cancelled = true; };
  }, [selectedSymbol]);

  // Mount chart
  useEffect(() => {
    if (!miniChartRef.current || !chartCandles || chartCandles.length === 0) return;
    const chart = createChart(miniChartRef.current, {
      layout: { background: { type: ColorType.Solid, color: "#ffffff" }, textColor: "#374151" },
      grid: { vertLines: { color: "#e5e7eb" }, horzLines: { color: "#e5e7eb" } },
      crosshair: { mode: CrosshairMode.Normal },
      width: miniChartRef.current.clientWidth,
      height: miniChartRef.current.clientHeight,
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: "#16a34a", downColor: "#dc2626", borderVisible: false,
      wickUpColor: "#16a34a", wickDownColor: "#dc2626",
    });
    series.setData(
      chartCandles.filter(c => c.open != null && c.high != null && c.low != null && c.close != null)
        .map(c => ({ time: c.time as `${number}-${number}-${number}`, open: c.open!, high: c.high!, low: c.low!, close: c.close! }))
    );
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [chartCandles]);

  // Drag and drop handlers
  const onDragStart = (symbol: string) => { dragSymbol.current = symbol; };
  const onDragOver = (e: React.DragEvent, overSymbol: string) => {
    e.preventDefault();
    if (!dragSymbol.current || dragSymbol.current === overSymbol) return;
    setOrder(prev => {
      const next = [...prev];
      const from = next.indexOf(dragSymbol.current!);
      const to = next.indexOf(overSymbol);
      if (from === -1 || to === -1) return prev;
      next.splice(from, 1);
      next.splice(to, 0, dragSymbol.current!);
      return next;
    });
  };
  const onDrop = (e: React.DragEvent) => { e.preventDefault(); };
  const onDragEnd = () => {
    dragSymbol.current = null;
    // Save final order to DB
    setOrder(prev => {
      fetch("/api/markets/order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order: prev }),
      }).catch(() => {});
      return prev;
    });
  };

  const sortedQuotes = data?.quotes
    ? [...data.quotes].sort((a, b) => {
        const ia = order.indexOf(a.symbol), ib = order.indexOf(b.symbol);
        if (ia === -1 && ib === -1) return 0;
        if (ia === -1) return 1; if (ib === -1) return -1;
        return ia - ib;
      })
    : [];

  const statusColor =
    fetchStatus === "fetching" ? "bg-yellow-400 animate-pulse" :
    fetchStatus === "success" ? "bg-green-500" :
    fetchStatus === "error" ? "bg-red-500" : "bg-gray-300";

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-[var(--text)]">Market Dashboard</h3>
          <span className={`inline-block h-2 w-2 rounded-full transition-colors duration-300 ${statusColor}`} title={fetchStatus} />
        </div>
        {data?.updatedAt && (
          <span className="text-[10px] text-[var(--muted)]">
            {new Date(data.updatedAt).toLocaleTimeString()}
          </span>
        )}
      </div>

      {loading && <div className="text-xs text-[var(--muted)]">Loading markets…</div>}
      {error && !loading && (
        <div className="rounded border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-700">{error}</div>
      )}

      {!loading && !error && (
        <div className="overflow-auto rounded-md border border-[var(--border)] bg-[var(--card)] shadow-sm">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--border)]">
                <th className="px-3 py-1.5 text-left text-[10px] font-semibold tracking-widest uppercase text-[var(--muted)]">Symbol</th>
                <th className="px-2 py-1.5 text-right text-[10px] font-semibold tracking-widest uppercase text-[var(--muted)]">Price</th>
                <th className="px-2 py-1.5 text-right text-[10px] font-semibold tracking-widest uppercase text-[var(--muted)]">Chg</th>
                <th className="px-2 py-1.5 text-right text-[10px] font-semibold tracking-widest uppercase text-[var(--muted)]">Day%</th>
              </tr>
            </thead>
            <tbody>
              {sortedQuotes.map((q) => {
                const up = typeof q.change === "number" && q.change > 0;
                const dn = typeof q.change === "number" && q.change < 0;
                const clr = up ? "text-green-600" : dn ? "text-red-600" : "text-[var(--muted)]";
                const ledColor = up ? "#16a34a" : dn ? "#dc2626" : "#9ca3af";
                const ledGlow = up
                  ? "0 0 5px rgba(22,163,74,0.7), 0 0 2px rgba(22,163,74,0.5)"
                  : dn
                  ? "0 0 5px rgba(220,38,38,0.7), 0 0 2px rgba(220,38,38,0.5)"
                  : "none";
                const flash = flashMap.get(q.symbol);
                const rowBg = flash === "up"
                  ? "rgba(22,163,74,0.18)"
                  : flash === "dn"
                  ? "rgba(220,38,38,0.18)"
                  : up
                  ? "rgba(22,163,74,0.04)"
                  : dn
                  ? "rgba(220,38,38,0.04)"
                  : "transparent";
                const rowBorderColor = up ? "rgba(22,163,74,0.5)" : dn ? "rgba(220,38,38,0.5)" : "transparent";
                return (
                  <tr
                    key={q.symbol}
                    draggable
                    onDragStart={() => onDragStart(q.symbol)}
                    onDragOver={(e) => onDragOver(e, q.symbol)}
                    onDrop={onDrop}
                    onDragEnd={onDragEnd}
                    onClick={() => setSelectedSymbol({ symbol: q.symbol, label: q.label })}
                    className="cursor-grab active:cursor-grabbing select-none border-t border-[var(--border)]"
                    style={{
                      background: rowBg,
                      borderLeft: `3px solid ${rowBorderColor}`,
                      transition: "background 0.6s ease-out",
                    }}
                  >
                    <td className="px-2 py-[7px] text-left">
                      <div className="flex items-center gap-2">
                        <span
                          style={{
                            display: "inline-block",
                            width: 6, height: 6,
                            borderRadius: "50%",
                            background: ledColor,
                            boxShadow: ledGlow,
                            flexShrink: 0,
                          }}
                        />
                        <span className="font-semibold text-[var(--text)] text-xs">{q.label}</span>
                      </div>
                    </td>
                    <td className="px-2 py-[7px] text-right tabular-nums text-xs font-medium text-[var(--text)]">{fmt(q.price)}</td>
                    <td className={`px-2 py-[7px] text-right tabular-nums text-xs font-semibold ${clr}`}>{fmtChg(q.change)}</td>
                    <td className={`px-2 py-[7px] text-right tabular-nums text-xs font-bold ${clr}`}>{fmtPct(q.changePercent)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Chart popup */}
      {selectedSymbol && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setSelectedSymbol(null)}>
          <div className="relative rounded-lg border border-[var(--border)] bg-white p-5 shadow-xl" style={{ width: "95vw", maxWidth: "95vw" }} onClick={e => e.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between">
              <span className="text-base font-semibold text-[var(--text)]">{selectedSymbol.label}</span>
              <div className="flex items-center gap-2">
                <div className="inline-flex items-center rounded-lg bg-[rgba(0,0,0,0.06)] p-[3px] gap-[2px]">
                  <span className="rounded-md bg-white px-3 py-[3px] text-xs font-semibold text-gray-900 shadow-sm">
                    Daily
                  </span>
                </div>
                <button onClick={() => setSelectedSymbol(null)} className="rounded px-2 py-0.5 text-sm text-[var(--muted)] hover:bg-gray-100">✕</button>
              </div>
            </div>
            {chartLoading && <div className="flex items-center justify-center" style={{ height: "calc(80vh - 60px)" }}><span className="text-sm text-[var(--muted)]">Loading chart…</span></div>}
            {!chartLoading && chartCandles !== null && chartCandles.length === 0 && <div className="flex items-center justify-center" style={{ height: "calc(80vh - 60px)" }}><span className="text-sm text-[var(--muted)]">No data.</span></div>}
            {!chartLoading && chartCandles && chartCandles.length > 0 && <div ref={miniChartRef} style={{ height: "calc(80vh - 60px)" }} />}
          </div>
        </div>
      )}
    </div>
  );
}
