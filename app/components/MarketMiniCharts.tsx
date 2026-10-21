"use client";

import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  ColorType,
  CrosshairMode,
  LineSeries,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type Time,
} from "lightweight-charts";

type Candle = { time: string; close: number };
type MarketDefinition = { symbols: string[]; label: string; digits?: number; fallbackLabel?: string };
type Ruler = { x1: number; x2: number; y1: number; y2: number; delta: number; percent: number } | null;
type Tooltip = { x: number; y: number; date: string; price: number } | null;
type FutuSnapshot = {
  price?: number;
  lastClose?: number | null;
  changePercent?: number | null;
  updateTime?: string;
};
type VerifiedQuote = {
  price: number;
  previousClose: number | null;
  changePercent: number | null;
  updateTime: string;
  date: string;
};

const SESSION_COUNT = 260;
const TOP_MARKET_SESSION_COUNT = 30;

const TOP_MARKETS: MarketDefinition[] = [
  { symbols: ["0700.HK"], label: "0700" },
  { symbols: ["9988.HK"], label: "9988" },
  { symbols: ["0005.HK"], label: "0005" },
];
const HSTECH_MARKET: MarketDefinition = {
  symbols: ["^HSTECH", "3032.HK"],
  label: "Hang Seng TECH",
  fallbackLabel: "ETF proxy",
};
const FX_MARKETS: MarketDefinition[] = [
  { symbols: ["USDHKD=X"], label: "USD / HKD", digits: 4 },
  { symbols: ["CNH=X", "CNY=X"], label: "USD / CNH", digits: 4, fallbackLabel: "CNY proxy" },
];
const LOWER_MARKETS: MarketDefinition[] = [
  { symbols: ["CN=F", "2823.HK"], label: "FTSE China A50 Futures", fallbackLabel: "A50 ETF proxy" },
  { symbols: ["NQ=F"], label: "Nasdaq 100 Futures" },
  { symbols: ["ES=F"], label: "S&P 500 Futures" },
];

const FUTU_SNAPSHOT_CODES: Record<string, string> = {
  "0700.HK": "HK.00700",
  "9988.HK": "HK.09988",
  "0005.HK": "HK.00005",
};

function timeLabel(time: Time | undefined) {
  if (typeof time === "string") return time;
  if (typeof time === "number") return new Date(time * 1000).toISOString().slice(0, 10);
  if (time && typeof time === "object") {
    return `${time.year}-${String(time.month).padStart(2, "0")}-${String(time.day).padStart(2, "0")}`;
  }
  return "";
}

function mergeVerifiedQuote(candles: Candle[], quote: VerifiedQuote | null, sessionCount: number) {
  const next = candles.slice();
  if (!quote) return next.slice(-sessionCount);
  const sameDateIndex = next.findIndex((bar) => bar.time === quote.date);
  if (sameDateIndex >= 0) {
    next[sameDateIndex] = { time: quote.date, close: quote.price };
  } else if (!next.at(-1) || quote.date > next.at(-1)!.time) {
    next.push({ time: quote.date, close: quote.price });
  }
  return next.slice(-sessionCount);
}

function MiniChart({
  market,
  compact = false,
  sessionCount = SESSION_COUNT,
}: {
  market: MarketDefinition;
  compact?: boolean;
  sessionCount?: number;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const verifiedQuoteRef = useRef<VerifiedQuote | null>(null);
  const hasFitRef = useRef(false);
  const rulerStartRef = useRef(0);
  const [candles, setCandles] = useState<Candle[]>([]);
  const [usingFallback, setUsingFallback] = useState(false);
  const [ruler, setRuler] = useState<Ruler>(null);
  const [dragging, setDragging] = useState(false);
  const [tooltip, setTooltip] = useState<Tooltip>(null);
  const [verifiedQuote, setVerifiedQuote] = useState<VerifiedQuote | null>(null);

  useEffect(() => {
    let cancelled = false;
    const storageKey = `market-mini:${market.label}`;
    try {
      const saved = JSON.parse(window.localStorage.getItem(storageKey) ?? "null") as {
        candles?: Candle[]; usingFallback?: boolean;
      } | null;
      if (saved?.candles?.length) {
        queueMicrotask(() => {
          if (cancelled) return;
          setCandles(saved.candles!.slice(-sessionCount));
          setUsingFallback(Boolean(saved.usingFallback));
        });
      }
    } catch {
      // Browser cache is optional.
    }

    const load = async (forceRefresh = false) => {
      try {
        for (let index = 0; index < market.symbols.length; index += 1) {
          const response = await fetch(
            `/api/markets/chart?symbol=${encodeURIComponent(market.symbols[index])}${forceRefresh ? `&refresh=1&_=${Date.now()}` : ""}`,
            { cache: "no-store" }
          );
          if (!response.ok) continue;
          const payload = (await response.json()) as { candles?: Candle[] };
          const rows = payload.candles ?? [];
          if (rows.length < 20) continue;
          if (!cancelled) {
            const dailyCandles = rows.slice(-sessionCount);
            const nextFallback = index > 0;
            // Daily history may finish after the Futu event. Re-read the quote
            // ref inside the updater so an older Yahoo response cannot win.
            setCandles(() => mergeVerifiedQuote(dailyCandles, verifiedQuoteRef.current, sessionCount));
            setUsingFallback(nextFallback);
            try {
              window.localStorage.setItem(storageKey, JSON.stringify({ candles: dailyCandles, usingFallback: nextFallback }));
            } catch {
              // Rendering does not depend on browser storage.
            }
          }
          break;
        }
      } catch {
        // Leave the last valid chart in place.
      }
    };

    load();
    // Disk-backed chart responses use stale-while-revalidate. A quick second read
    // picks up the just-refreshed current session instead of leaving yesterday's
    // close visible until the regular one-minute poll.
    const warmupId = window.setTimeout(load, 3_000);
    const refreshAll = () => {
      // Re-read every panel on the five-second cycle, but respect the server's
      // daily-bar cache. Forcing six Yahoo histories every five seconds caused
      // provider throttling and made stale fallbacks look like live data.
      void load(false);
    };
    const applyFutuSnapshots = (event: Event) => {
      const code = FUTU_SNAPSHOT_CODES[market.symbols[0]];
      if (!code) return;
      const snapshots = (event as CustomEvent<Record<string, FutuSnapshot>>).detail;
      const snapshot = snapshots?.[code];
      const price = Number(snapshot?.price);
      const updateTime = snapshot?.updateTime ?? "";
      const date = updateTime.slice(0, 10);
      if (!date || !Number.isFinite(price) || price <= 0) return;
      if (verifiedQuoteRef.current && updateTime < verifiedQuoteRef.current.updateTime) return;

      const providerPreviousClose = Number(snapshot?.lastClose);
      const previousClose = Number.isFinite(providerPreviousClose) && providerPreviousClose > 0
        ? providerPreviousClose
        : null;
      const providerChangePercent = snapshot?.changePercent;
      const changePercent = typeof providerChangePercent === "number" && Number.isFinite(providerChangePercent)
        ? providerChangePercent
        : previousClose
          ? ((price - previousClose) / previousClose) * 100
          : null;
      const nextQuote: VerifiedQuote = { price, previousClose, changePercent, updateTime, date };
      verifiedQuoteRef.current = nextQuote;
      setVerifiedQuote(nextQuote);
      setCandles((previous) => mergeVerifiedQuote(previous, nextQuote, sessionCount));
    };
    window.addEventListener("market-data:refresh-all", refreshAll);
    window.addEventListener("market-data:futu-snapshots", applyFutuSnapshots);
    return () => {
      cancelled = true;
      window.removeEventListener("market-data:refresh-all", refreshAll);
      window.removeEventListener("market-data:futu-snapshots", applyFutuSnapshots);
      window.clearTimeout(warmupId);
    };
  }, [market, sessionCount]);

  const values = useMemo(() => candles.map((bar) => Number(bar.close)), [candles]);
  const candleLatest = values.at(-1);
  const candlePrevious = values.at(-2);
  const requiresFutuQuote = Boolean(FUTU_SNAPSHOT_CODES[market.symbols[0]]);
  // The top stock-card header must never fall back to Yahoo's daily close.
  // Until the first Futu tuple arrives, a truthful placeholder is safer than
  // briefly displaying a different provider's price and percent.
  const latest = requiresFutuQuote ? verifiedQuote?.price : candleLatest;
  const change = requiresFutuQuote
    ? verifiedQuote?.changePercent ?? null
    : candleLatest !== undefined && candlePrevious
      ? ((candleLatest - candlePrevious) / candlePrevious) * 100
      : null;
  const rising = change === null || change >= 0;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const chart = createChart(host, {
      width: host.clientWidth,
      height: host.clientHeight,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#6b7280",
        fontSize: 9,
        attributionLogo: false,
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { visible: false },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: "rgba(75,85,99,0.5)", width: 1, labelVisible: false },
        horzLine: { color: "rgba(75,85,99,0.38)", width: 1, labelVisible: false },
      },
      rightPriceScale: { visible: false, borderVisible: false },
      leftPriceScale: { visible: false, borderVisible: false },
      timeScale: {
        visible: false,
        borderVisible: false,
        rightOffset: 5,
        barSpacing: 2.4,
        minBarSpacing: 0.35,
        fixLeftEdge: false,
        fixRightEdge: false,
      },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
    });
    const series = chart.addSeries(LineSeries, {
      color: "#dc2626",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: true,
      crosshairMarkerRadius: 3,
      priceFormat: {
        type: "price",
        precision: market.digits ?? 2,
        minMove: market.digits === 4 ? 0.0001 : 0.01,
      },
    });
    chartRef.current = chart;
    seriesRef.current = series;

    chart.subscribeCrosshairMove((param) => {
      const point = param.point;
      const item = param.seriesData.get(series);
      if (!point || !param.time || !item || !("value" in item) || typeof item.value !== "number") {
        setTooltip(null);
        return;
      }
      setTooltip({ x: point.x, y: point.y, date: timeLabel(param.time), price: item.value });
    });

    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      chart.applyOptions({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(host);

    return () => {
      observer.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      hasFitRef.current = false;
    };
  }, [market.digits]);

  useEffect(() => {
    const series = seriesRef.current;
    const chart = chartRef.current;
    if (!series || !chart || candles.length === 0) return;
    series.applyOptions({ color: rising ? "#059669" : "#dc2626" });
    series.setData(candles.map((bar, index) => ({ time: bar.time, value: values[index] })).filter((point) => Number.isFinite(point.value)));
    if (!hasFitRef.current) {
      chart.timeScale().fitContent();
      hasFitRef.current = true;
    }
  }, [candles, rising, values]);

  const indexFromPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const chart = chartRef.current;
    if (!chart) return 0;
    const bounds = event.currentTarget.getBoundingClientRect();
    const logical = chart.timeScale().coordinateToLogical(event.clientX - bounds.left);
    return Math.min(values.length - 1, Math.max(0, Math.round(logical ?? 0)));
  };

  const rulerFromIndexes = (startIndex: number, endIndex: number): Ruler => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (!chart || !series || values.length === 0) return null;
    const start = Math.min(values.length - 1, Math.max(0, startIndex));
    const end = Math.min(values.length - 1, Math.max(0, endIndex));
    const x1 = chart.timeScale().timeToCoordinate(candles[start]?.time);
    const x2 = chart.timeScale().timeToCoordinate(candles[end]?.time);
    const y1 = series.priceToCoordinate(values[start]);
    const y2 = series.priceToCoordinate(values[end]);
    if ([x1, x2, y1, y2].some((value) => value === null || !Number.isFinite(value))) return null;
    const delta = values[end] - values[start];
    const percent = values[start] === 0 ? 0 : (delta / values[start]) * 100;
    return { x1: x1 as number, x2: x2 as number, y1: y1 as number, y2: y2 as number, delta, percent };
  };

  const startRuler = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!event.shiftKey || values.length < 2) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const index = indexFromPointer(event);
    rulerStartRef.current = index;
    setRuler(rulerFromIndexes(index, index));
    setDragging(true);
    setTooltip(null);
  };

  const moveRuler = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    event.preventDefault();
    event.stopPropagation();
    const index = indexFromPointer(event);
    setRuler(rulerFromIndexes(rulerStartRef.current, index));
  };

  const endRuler = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    event.preventDefault();
    event.stopPropagation();
    setDragging(false);
    setRuler(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return (
    <section className={`relative flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--card)] shadow-sm ${compact ? "px-2 py-1.5" : "px-3 py-2"}`}>
      <div className={compact ? "grid gap-0.5" : "flex items-start justify-between gap-2"}>
        <div className={`font-bold leading-tight text-[var(--text)] ${compact ? "text-[11px]" : "truncate text-[13px]"}`}>{market.label}</div>
        <div
          className={`shrink-0 font-semibold leading-tight tabular-nums ${compact ? "text-left text-[11px]" : "text-right text-[12px]"}`}
          title={verifiedQuote
            ? `Futu ${verifiedQuote.updateTime} · previous close ${verifiedQuote.previousClose ?? "unavailable"}`
            : requiresFutuQuote ? "Waiting for verified Futu quote" : "Daily provider close"}
        >
          <span className="font-semibold text-[var(--text)]">
            {latest === undefined ? "—" : latest.toLocaleString("en-US", { maximumFractionDigits: market.digits ?? 2 })}
          </span>
          {change !== null && (
            <span className={`ml-1 font-semibold ${rising ? "text-emerald-600" : "text-red-600"}`}>
              {rising ? "+" : ""}{change.toFixed(2)}%
            </span>
          )}
        </div>
      </div>

      <div
        className={`relative mt-1 min-h-0 flex-1 select-none ${dragging ? "cursor-crosshair" : "cursor-grab active:cursor-grabbing"}`}
        onPointerDownCapture={startRuler}
        onPointerMoveCapture={moveRuler}
        onPointerUpCapture={endRuler}
        onPointerCancelCapture={() => { setDragging(false); setRuler(null); }}
        onLostPointerCapture={() => { setDragging(false); setRuler(null); }}
      >
        <div ref={hostRef} className="absolute inset-0" aria-label={`${market.label} interactive daily line chart`} />
        {tooltip && !dragging && (
          <div
            className="pointer-events-none absolute z-30 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-md border px-2 py-1.5 text-[12px] font-bold leading-tight shadow-lg"
            style={{
              left: `clamp(48px, ${tooltip.x}px, calc(100% - 48px))`,
              top: `${Math.max(30, tooltip.y - 7)}px`,
              color: "#ffffff",
              backgroundColor: "#111827",
              borderColor: "#374151",
            }}
          >
            {tooltip.price.toLocaleString("en-US", { maximumFractionDigits: market.digits ?? 2 })}<br />
            <span className="font-medium" style={{ color: "#d1d5db" }}>{tooltip.date}</span>
          </div>
        )}
        {ruler && (
          <svg className="pointer-events-none absolute inset-0 h-full w-full overflow-visible">
            <rect x={Math.min(ruler.x1, ruler.x2)} y="0" width={Math.max(1, Math.abs(ruler.x2 - ruler.x1))} height="100%" fill={ruler.delta >= 0 ? "rgba(5,150,105,0.09)" : "rgba(220,38,38,0.09)"} />
            <path d={`M${ruler.x1} 0V999 M${ruler.x2} 0V999`} stroke="#4b5563" strokeWidth="1" strokeDasharray="3 3" />
            <path d={`M${ruler.x1} ${ruler.y1}L${ruler.x2} ${ruler.y2}`} stroke={ruler.delta >= 0 ? "#059669" : "#dc2626"} strokeWidth="2" strokeDasharray="4 3" />
            <circle cx={ruler.x1} cy={ruler.y1} r="3.5" fill="#fff" stroke="#374151" strokeWidth="1.5" />
            <circle cx={ruler.x2} cy={ruler.y2} r="3.5" fill="#fff" stroke="#374151" strokeWidth="1.5" />
          </svg>
        )}
      </div>

      <div className={`flex items-center justify-between gap-2 font-medium uppercase tracking-wide text-[var(--muted)] ${compact ? "min-h-[14px] text-[9px]" : "min-h-[18px] text-[10px]"}`}>
        <span>Daily bars · {Math.min(sessionCount, candles.length)} sessions{usingFallback && market.fallbackLabel ? ` · ${market.fallbackLabel}` : ""}</span>
        {!compact && <span className="normal-case opacity-70">Drag · wheel · Shift measure</span>}
      </div>
      {ruler && (
        <span className={`absolute bottom-1.5 right-2 z-20 rounded px-2.5 py-1.5 text-[13px] font-bold leading-none tabular-nums text-white shadow-md ring-1 ring-white/70 ${ruler.delta >= 0 ? "bg-emerald-600" : "bg-red-600"}`}>
          Δ {ruler.delta >= 0 ? "+" : ""}{ruler.delta.toLocaleString("en-US", { maximumFractionDigits: market.digits ?? 2 })} · {ruler.percent >= 0 ? "+" : ""}{ruler.percent.toFixed(2)}%
        </span>
      )}
    </section>
  );
}

export default function MarketMiniCharts() {
  return (
    <aside
      className="grid h-full min-h-0 gap-3"
      style={{ gridTemplateRows: "0.85fr 1.15fr 0.9fr repeat(3, minmax(0, 1fr))" }}
      aria-label="Related daily markets"
    >
      <div className="grid min-h-0 min-w-0 grid-cols-3 gap-3">
        {TOP_MARKETS.map((market) => (
          <MiniChart
            key={market.label}
            market={market}
            compact
            sessionCount={TOP_MARKET_SESSION_COUNT}
          />
        ))}
      </div>
      <MiniChart market={HSTECH_MARKET} />
      <div className="grid min-h-0 min-w-0 grid-cols-2 gap-3">
        {FX_MARKETS.map((market) => <MiniChart key={market.label} market={market} compact />)}
      </div>
      {LOWER_MARKETS.map((market) => <MiniChart key={market.label} market={market} />)}
    </aside>
  );
}
