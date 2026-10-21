"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CandlestickSeries, CrosshairMode, createChart, LineStyle, type UTCTimestamp } from "lightweight-charts";

type Level = { side: "bull" | "bear"; price: number; streetVolume: number };

type Candle = { time: UTCTimestamp; open: number; high: number; low: number; close: number };

export default function HsiIntradayModal({ onClose, levels, cbbcStale }: {
  onClose: () => void; levels: Level[]; cbbcStale: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const series = useRef<ReturnType<ReturnType<typeof createChart>["addSeries"]> | null>(null);
  const [status, setStatus] = useState("Loading 15-minute candles…");
  const [ready, setReady] = useState(false);
  const [spotPrice, setSpotPrice] = useState<number | null>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialog.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "Tab") {
        event.preventDefault();
        dialog.current?.querySelector<HTMLButtonElement>("button")?.focus();
      }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener("keydown", keydown);
      previous?.focus();
    };
  }, [onClose]);

  useEffect(() => {
    if (!host.current) return;
    const format = (time: number) => new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Hong_Kong", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
    }).format(new Date(time * 1000));
    const chart = createChart(host.current, {
      autoSize: true,
      crosshair: { mode: CrosshairMode.Normal },
      layout: { textColor: "#475569", background: { color: "#ffffff" } },
      grid: { vertLines: { color: "#f1f5f9" }, horzLines: { color: "#f1f5f9" } },
      timeScale: { timeVisible: true, secondsVisible: false, rightOffset: 12, tickMarkFormatter: (time: number) => format(time) },
      localization: { timeFormatter: (time: number) => format(time) },
    });
    const candles = chart.addSeries(CandlestickSeries, { upColor: "#26a69a", downColor: "#ef5350", borderVisible: false, wickUpColor: "#26a69a", wickDownColor: "#ef5350" });
    series.current = candles;
    setReady(true);
    let disposed = false;
    let busy = false;
    let initial = true;
    const controller = new AbortController();
    const refresh = async () => {
      if (busy) return;
      busy = true;
      try {
        const response = await fetch("/api/futu/hsi-intraday", { cache: "no-store", signal: controller.signal });
        const payload = await response.json();
        if (!response.ok || !payload.ok || payload.symbol !== "HK.800000" || !Array.isArray(payload.candles) || payload.candles.length < 850) throw new Error(payload.error || "No candles available");
        if (disposed) return;
        const range = chart.timeScale().getVisibleLogicalRange();
        candles.setData(payload.candles as Candle[]);
        if (initial) {
          chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, payload.candles.length - 100), to: payload.candles.length + 12 });
          initial = false;
        } else if (range) chart.timeScale().setVisibleLogicalRange(range);
        const last = payload.candles.at(-1).time;
        setSpotPrice(Number(payload.candles.at(-1).close));
        const old = Date.now() / 1000 - last > 30 * 60;
        setStatus(`${payload.stale || old ? "STALE · " : ""}${payload.candles.length.toLocaleString()} bars · Latest bar ${format(last)} HKT${payload.stale ? " · feed unavailable" : ""}`);
      } catch {
        if (!disposed) { setStatus("15-minute feed unavailable · retaining any loaded candles"); }
      } finally { busy = false; }
    };
    void refresh();
    const timer = setInterval(refresh, 5000);
    return () => { disposed = true; controller.abort(); clearInterval(timer); series.current = null; chart.remove(); };
  }, []);

  useEffect(() => {
    const current = series.current;
    if (!current || !ready) return;
    const visibleLevels = levels
      .filter(level => Number.isFinite(level.price))
      .filter(level => spotPrice === null || (
        Math.abs(level.price - spotPrice) <= 1800 &&
        (level.side === "bull" ? level.price < spotPrice : level.price > spotPrice)
      ))
      .sort((a, b) => b.streetVolume - a.streetVolume)
      .slice(0, 18);
    const lines = visibleLevels.map(level => current.createPriceLine({
      price: level.price, color: level.side === "bull" ? "#57a66a" : "#d76a6a", lineWidth: 1, lineStyle: LineStyle.Dotted,
      axisLabelVisible: true, title: `${level.side === "bull" ? "Bull" : "Bear"} ${(level.streetVolume / 1_000_000).toFixed(0)}M`,
    }));
    return () => { if (series.current === current) lines.forEach(line => current.removePriceLine(line)); };
  }, [levels, ready, spotPrice]);

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/35 p-6" onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="hsi-intraday-title" tabIndex={-1} className="flex h-[76vh] w-[min(72vw,1400px)] min-w-0 flex-col rounded-xl border border-gray-200 bg-white p-5 shadow-2xl outline-none max-md:w-full">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div><h2 id="hsi-intraday-title" className="font-semibold text-gray-900">HSI Spot · 15 minute · CBBC</h2><p className="mt-1 text-xs text-gray-500">Futu HK.800000 HSI spot index · {status}</p></div>
          <button onClick={onClose} aria-label="Close 15-minute chart" className="rounded-md px-3 py-1 text-xl text-gray-500 hover:bg-gray-100">×</button>
        </div>
        <div ref={host} className="min-h-0 flex-1" />
        <p className="mt-3 text-xs text-gray-500">CBBC actual cash-index recovery levels · Bull green / Bear red · Outstanding street volume (millions){cbbcStale ? " · CBBC stale" : ""}{!levels.length ? " · CBBC levels unavailable" : ""} · Times in HKT</p>
      </div>
    </div>, document.body,
  );
}
