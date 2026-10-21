"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  createChart,
  HistogramSeries,
  LineStyle,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type Time,
} from "lightweight-charts";

type Candle = { date: string; open: number; high: number; low: number; close: number; volume: number };
type Snapshot = {
  price: number;
  open: number;
  high: number;
  low: number;
  volume: number;
  turnover: number;
  updateTime: string;
};
type CbbcLevel = {
  side: "bull" | "bear";
  price: number;
  products: number;
  streetVolume: number;
  tradedVolume: number;
};
type MarketPayload = {
  ok: boolean;
  error?: string;
  candles?: Candle[];
  snapshots?: Record<string, Snapshot>;
  cbbcLevels?: CbbcLevel[];
  cbbcTotal?: number;
  cbbcActive?: number;
  fetchedAt?: string;
};
type FlowRow = { date: string; money_flow_million: number };
type FlowPayload = { rows?: FlowRow[]; meta?: { fetched_at_utc?: string } };
type CbbcTag = CbbcLevel & { x: number; y: number; color: string };

function hkToday() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Hong_Kong",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export default function MarketDataPanel() {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const longFlowRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const shortFlowRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const priceLinesRef = useRef<Array<{ key: string; line: IPriceLine }>>([]);
  const visibleLevelsRef = useRef<CbbcLevel[]>([]);
  const cashPriceRef = useRef<number | null>(null);
  const [payload, setPayload] = useState<MarketPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [flowFreshness, setFlowFreshness] = useState<string | null>(null);
  const [cbbcTags, setCbbcTags] = useState<CbbcTag[]>([]);

  const updateCbbcTags = useCallback(() => {
    const series = candleRef.current;
    const width = containerRef.current?.clientWidth || 0;
    if (!series || width <= 0) return;
    const levels = visibleLevelsRef.current;
    const maxBySide = levels.reduce(
      (max, level) => ({ ...max, [level.side]: Math.max(max[level.side], level.streetVolume) }),
      { bull: 1, bear: 1 }
    );
    const rightX = Math.max(12, width - 154);
    const leftX = Math.max(12, rightX - 62);
    const tags = levels.flatMap((level) => {
      const y = series.priceToCoordinate(level.price);
      if (y === null || !Number.isFinite(y)) return [];
      const isLarge = level.streetVolume / maxBySide[level.side] >= 0.5;
      const cashPrice = cashPriceRef.current;
      const knockedOut = Number.isFinite(cashPrice) && (level.side === "bull" ? cashPrice! <= level.price : cashPrice! >= level.price);
      return [{
        ...level,
        x: isLarge ? rightX : leftX,
        y,
        color: knockedOut ? "rgba(115,115,115,0.7)" : level.side === "bull" ? "#16a34a" : "#dc2626",
      }];
    });
    setCbbcTags(tags);
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const chart = createChart(container, {
      width: container.clientWidth,
      height: container.clientHeight,
      layout: {
        background: { type: ColorType.Solid, color: "#ffffff" },
        textColor: "#525252",
        fontSize: 11,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: "#f3f4f6" },
        horzLines: { color: "#f3f4f6" },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: "#e5e7eb" },
      timeScale: { borderColor: "#e5e7eb", rightOffset: 6 },
    });

    const candles = chart.addSeries(CandlestickSeries, {
      upColor: "#16a34a",
      downColor: "#dc2626",
      wickUpColor: "#15803d",
      wickDownColor: "#b91c1c",
      borderVisible: false,
      priceLineVisible: true,
    });
    const volume = chart.addSeries(HistogramSeries, {
      priceScaleId: "volume",
      priceFormat: { type: "volume" },
    });
    chart.priceScale("volume").applyOptions({
      scaleMargins: { top: 0.79, bottom: 0.02 },
      borderVisible: false,
    });

    chart.addPane();
    chart.panes()[0].setStretchFactor(1);
    chart.panes()[1].setStretchFactor(0.28);
    const longFlow = chart.addSeries(HistogramSeries, {
      priceScaleId: "right",
      priceFormat: { type: "volume" },
    }, 1);
    chart.panes()[1].priceScale("right").applyOptions({ borderVisible: false });

    chart.addPane();
    chart.panes()[2].setStretchFactor(0.28);
    const shortFlow = chart.addSeries(HistogramSeries, {
      priceScaleId: "right",
      priceFormat: { type: "volume" },
    }, 2);
    chart.panes()[2].priceScale("right").applyOptions({ borderVisible: false });

    chartRef.current = chart;
    candleRef.current = candles;
    volumeRef.current = volume;
    longFlowRef.current = longFlow;
    shortFlowRef.current = shortFlow;

    const observer = new ResizeObserver(([entry]) => {
      chart.applyOptions({ width: entry.contentRect.width, height: entry.contentRect.height });
      window.requestAnimationFrame(updateCbbcTags);
    });
    observer.observe(container);
    chart.timeScale().subscribeVisibleLogicalRangeChange(updateCbbcTags);
    return () => {
      observer.disconnect();
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(updateCbbcTags);
      chart.remove();
      chartRef.current = null;
      priceLinesRef.current = [];
      visibleLevelsRef.current = [];
    };
  }, [updateCbbcTags]);

  const applyCbbcLines = useCallback((data: MarketPayload) => {
    const series = candleRef.current;
    if (!series) return;

    const cashPrice = data.snapshots?.["HK.800000"]?.price;
    if (!Number.isFinite(cashPrice)) return;
    const levels = (data.cbbcLevels || [])
      .filter((level) => Math.abs(level.price - cashPrice) <= 1800)
      .slice(0, 18)
      .sort((a, b) => a.price - b.price);
    // Preserve the last verified overlay across transient empty live responses.
    if (levels.length === 0) return;
    visibleLevelsRef.current = levels;

    const existingLines = new Map(priceLinesRef.current.map((item) => [item.key, item.line] as const));
    const nextPriceLines: Array<{ key: string; line: IPriceLine }> = [];
    levels.forEach((level) => {
      const key = `${level.side}:${level.price}`;
      const knockedOut = level.side === "bull" ? cashPrice <= level.price : cashPrice >= level.price;
      const lineOptions = {
        price: level.price,
        color: knockedOut
          ? "rgba(115,115,115,0.35)"
          : level.side === "bull" ? "rgba(22,163,74,0.50)" : "rgba(220,38,38,0.50)",
        lineWidth: 1 as const,
        lineStyle: LineStyle.Dotted,
        axisLabelVisible: false,
        title: "",
      };
      const existing = existingLines.get(key);
      if (existing) {
        existing.applyOptions(lineOptions);
        nextPriceLines.push({ key, line: existing });
        existingLines.delete(key);
        return;
      }
      nextPriceLines.push({ key, line: series.createPriceLine(lineOptions) });
    });
    // Mount new lines before removing obsolete ones so the overlay never blanks.
    existingLines.forEach((line) => {
      try { series.removePriceLine(line); } catch { /* already removed */ }
    });
    priceLinesRef.current = nextPriceLines;
    window.requestAnimationFrame(updateCbbcTags);
  }, [updateCbbcTags]);

  const applyLive = useCallback((data: MarketPayload) => {
    const cash = data.snapshots?.["HK.800000"];
    const futures = data.snapshots?.["HK.HSImain"];
    cashPriceRef.current = cash?.price ?? null;
    if (cash && candleRef.current && cash.open > 0 && cash.price > 0) {
      candleRef.current.update({
        time: hkToday() as Time,
        open: cash.open,
        high: Math.max(cash.high, cash.open, cash.price),
        low: Math.min(cash.low, cash.open, cash.price),
        close: cash.price,
      });
    }
    if (futures && volumeRef.current) {
      volumeRef.current.update({
        time: hkToday() as Time,
        value: futures.volume,
        color: cash && cash.price >= cash.open ? "rgba(22,163,74,0.45)" : "rgba(220,38,38,0.45)",
      });
    }
    applyCbbcLines(data);
  }, [applyCbbcLines]);

  useEffect(() => {
    let cancelled = false;
    let retryTimer: number | null = null;
    const load = async () => {
      try {
        const [marketRes, longRes, shortRes] = await Promise.all([
          fetch("/api/futu/market-data", { cache: "no-store" }),
          fetch("/api/moneyflow/long", { cache: "no-store" }),
          fetch("/api/moneyflow/short", { cache: "no-store" }),
        ]);
        const market = (await marketRes.json()) as MarketPayload;
        if (!marketRes.ok || !market.ok) throw new Error(market.error || "Futu market data failed.");
        const longData = longRes.ok ? await longRes.json() as FlowPayload : {};
        const shortData = shortRes.ok ? await shortRes.json() as FlowPayload : {};
        if (cancelled) return;

        const candles = market.candles || [];
        candleRef.current?.setData(candles.map((bar) => ({
          time: bar.date as Time,
          open: bar.open,
          high: bar.high,
          low: bar.low,
          close: bar.close,
        })));
        volumeRef.current?.setData(candles.map((bar) => ({
          time: bar.date as Time,
          value: bar.volume,
          color: bar.close >= bar.open ? "rgba(22,163,74,0.45)" : "rgba(220,38,38,0.45)",
        })));
        const colors = (rows: FlowRow[], positive: string, negative: string) => rows.map((row) => ({
          time: row.date.slice(0, 10) as Time,
          value: Number(row.money_flow_million),
          color: Number(row.money_flow_million) >= 0 ? positive : negative,
        }));
        longFlowRef.current?.setData(colors(longData.rows || [], "#2563eb", "#dc2626"));
        shortFlowRef.current?.setData(colors(shortData.rows || [], "#dc2626", "#2563eb"));
        setFlowFreshness(longData.meta?.fetched_at_utc || null);
        setPayload(market);
        applyLive(market);
        chartRef.current?.timeScale().fitContent();
        setLoading(false);
      } catch (reason) {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : "Market Data failed.");
          setLoading(false);
          retryTimer = window.setTimeout(() => {
            if (!cancelled) {
              setLoading(true);
              setError(null);
              void load();
            }
          }, 10_000);
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
    };
  }, [applyLive]);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const response = await fetch("/api/futu/market-data?live=1", { cache: "no-store" });
        const data = await response.json() as MarketPayload;
        if (!cancelled && response.ok && data.ok) {
          setPayload((previous) => ({ ...previous, ...data } as MarketPayload));
          applyLive(data);
        }
      } catch { /* retain the last verified values */ }
    };
    const timer = window.setInterval(poll, 5_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [applyLive]);

  const cash = payload?.snapshots?.["HK.800000"];
  const futures = payload?.snapshots?.["HK.HSImain"];

  return (
    <div className="flex h-full flex-col">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="rounded-md bg-neutral-100 px-3 py-1 text-xs font-semibold">Daily</span>
        <span className="inline-flex items-center gap-1.5 rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
          LIVE {cash?.price?.toLocaleString("en-US", { maximumFractionDigits: 2 }) || "—"}
        </span>
        <span className="rounded-md border border-neutral-200 px-2.5 py-1 text-[11px] text-neutral-600">
          Futures volume {futures?.volume?.toLocaleString("en-US") || "—"}
        </span>
        <span className="rounded-md border border-neutral-200 px-2.5 py-1 text-[11px] text-neutral-600">
          Futu CBBC {payload?.cbbcActive?.toLocaleString("en-US") || "—"} active
        </span>
        <span className="ml-auto text-[10px] text-neutral-400">
          {cash?.updateTime ? `${cash.updateTime} HKT` : "Connecting to OpenD…"}
        </span>
      </div>

      <div className="relative min-h-[620px] flex-1 overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-sm">
        <div ref={containerRef} className="h-full w-full" />
        <div className="pointer-events-none absolute inset-0 z-[3]">
          {cbbcTags.map((tag) => (
            <span
              key={`${tag.side}:${tag.price}`}
              className="absolute -translate-y-1/2 rounded-[3px] px-1.5 py-px text-[9px] font-semibold leading-3 text-white shadow-sm"
              style={{ left: tag.x, top: tag.y, backgroundColor: tag.color }}
              title={`${tag.side} recovery ${tag.price.toLocaleString("en-US")} · street volume ${tag.streetVolume.toLocaleString("en-US")}`}
            >
              {tag.streetVolume >= 1_000_000
                ? `${(tag.streetVolume / 1_000_000).toFixed(1)}m`
                : `${Math.round(tag.streetVolume / 1_000)}k`}
            </span>
          ))}
        </div>
        {loading && <div className="absolute inset-0 flex items-center justify-center bg-white/75 text-sm text-neutral-500">Loading verified Futu market data…</div>}
        {error && <div className="absolute inset-0 flex items-center justify-center bg-white/90 px-6 text-center text-sm text-red-600">{error}</div>}
      </div>

      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[10px] text-neutral-500">
        <span>Price: Futu HSI cash · Volume: Futu HSImain contracts · Dotted lines: exact Futu CBBC recovery prices</span>
        <span>Capital flow: existing long/short daily source{flowFreshness ? ` · refreshed ${flowFreshness}` : ""}</span>
      </div>
    </div>
  );
}
