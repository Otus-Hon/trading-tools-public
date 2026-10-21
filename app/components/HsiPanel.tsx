"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AreaSeries,
  BaselineSeries,
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  createChart,
  type Logical,
} from "lightweight-charts";
import { diag, diagError } from "@/lib/clientDiag";
import {
  cbbcLevelKnockedOut,
  mergeCbbcLevels,
  newlyKnockedOutLevels,
  normalizeStoredCbbcLevels,
  rowsToCbbcLevels,
  type CbbcKnockoutLevel,
} from "@/lib/cbbcKnockout";
import HsiIntradayModal from "./HsiIntradayModal";
import FuturesExpiryProgress from "./FuturesExpiryProgress";

type Candle = {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
};

type ApiResponse = {
  symbol: string;
  candles: Candle[];
};

type CbbcRow = {
  start?: number;
  end?: number;
  count?: number | null;
  history?: { date?: string; count?: number | null }[];
};

type CbbcResponse = {
  bearRows?: CbbcRow[];
  bullRows?: CbbcRow[];
  todayHigh?: number | null;
  todayLow?: number | null;
};

type MoneyFlowRow = {
  date?: string;
  money_flow_million?: number;
};

type MoneyFlowResponse = {
  rows?: MoneyFlowRow[];
};

type KnockoutAlert = {
  id: string;
  side: "bear" | "bull";
  price: number;
  start?: number;
  end?: number;
  volume: number;
  at: number; // epoch ms
};

type CbbcLineLabel = {
  key: string;
  side: "bear" | "bull";
  start: number;
  end: number;
  level: number;
  trigger: number;
  volume: number;
  x: number;
  y: number;
  color: string;
  knockedOut: boolean;
};

type CbbcPresentation = "general" | "detail";

type HsiPanelProps = {
  refreshToken: number;
  dataMode?: "main" | "futu";
  startupCheck?: {
    status: "checking" | "ok" | "warning" | "error";
    label: string;
    title?: string;
  };
};

type FutuMarketPayload = {
  ok?: boolean;
  cached?: boolean;
  stale?: boolean;
  liveUnavailable?: boolean;
  refreshError?: string;
  fetchedAt?: string;
  candles?: { date: string; open: number; high: number; low: number; close: number; volume: number }[];
  snapshots?: Record<string, {
    price: number; open: number; high: number; low: number; volume: number;
    openInterest?: number; openInterestChange?: number; updateTime: string;
  }>;
  cbbcLevels?: {
    side: "bull" | "bear"; price: number; streetVolume: number;
  }[];
  cbbcComplete?: boolean;
  cbbcRowsFetched?: number;
  cbbcTotal?: number;
  cbbcFetchedAt?: string;
  openInterestHistory?: Array<{ date: string; value: number; change?: number }>;
};

function adaptFutuCbbc(data: FutuMarketPayload): CbbcResponse {
  const cashPrice = Number(data.snapshots?.["HK.800000"]?.price);
  const levels = (Array.isArray(data.cbbcLevels) ? data.cbbcLevels : [])
    .filter((level) => Number.isFinite(level.price) && (!Number.isFinite(cashPrice) || Math.abs(level.price - cashPrice) <= 1800))
    .slice(0, 18);
  return {
    bearRows: levels.filter((level) => level.side === "bear").map((level) => ({
      start: level.price - 1,
      end: level.price - 1,
      count: level.streetVolume / 1_000_000,
    })),
    bullRows: levels.filter((level) => level.side === "bull").map((level) => ({
      start: level.price + 1,
      end: level.price + 1,
      count: level.streetVolume / 1_000_000,
    })),
  };
}

function colorForCbbcLine(side: "bear" | "bull", trigger: number, high: number | null, low: number | null) {
  if (cbbcLevelKnockedOut({ side, trigger }, high, low)) return "rgba(158, 158, 158, 0.6)";
  return side === "bear" ? "rgba(198, 40, 40, 0.7)" : "rgba(20, 140, 60, 0.7)";
}

function cbbcSessionStorageKey(detail: boolean) {
  return detail
    ? `hsi-cbbc-session-levels:${hkToday()}`
    : `hsi-cbbc-general-levels:${hkToday()}`;
}

function readStoredCbbcLevels(detail: boolean): CbbcKnockoutLevel[] {
  if (typeof window === "undefined") return [];
  try {
    return normalizeStoredCbbcLevels(JSON.parse(window.localStorage.getItem(cbbcSessionStorageKey(detail)) ?? "[]"));
  } catch {
    return [];
  }
}

function writeStoredCbbcLevels(detail: boolean, levels: CbbcKnockoutLevel[]) {
  try {
    window.localStorage.setItem(cbbcSessionStorageKey(detail), JSON.stringify(levels));
  } catch {
    // Session persistence is optional; the in-memory registry still alerts.
  }
}

function cbbcLineWidth(_volume: number, _maxVolume: number): 1 {
  return 1;
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function applyIntradayRange(
  rangeRef: { current: { high: number | null; low: number | null } },
  dateRef: { current: string | null },
  date: string | null | undefined,
  high: number | null,
  low: number | null,
) {
  if (!date) return rangeRef.current;
  const nextHigh = isPositiveNumber(high) ? high : null;
  const nextLow = isPositiveNumber(low) ? low : null;
  if (dateRef.current !== date) {
    dateRef.current = date;
    rangeRef.current = { high: nextHigh, low: nextLow };
    return rangeRef.current;
  }
  const current = rangeRef.current;
  rangeRef.current = {
    high: nextHigh === null ? current.high : current.high === null ? nextHigh : Math.max(current.high, nextHigh),
    low: nextLow === null ? current.low : current.low === null ? nextLow : Math.min(current.low, nextLow),
  };
  return rangeRef.current;
}

function hkToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Hong_Kong",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function parseHkFeedTime(raw: string | null | undefined) {
  const match = raw?.match(
    /(\d{4})[-/](\d{2})[-/](\d{2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/
  );
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hours = Number(match[4]);
  const minutes = Number(match[5]);
  const seconds = Number(match[6] ?? 0);
  const utcDate = new Date(Date.UTC(year, month - 1, day, hours - 8, minutes, seconds));

  return {
    date: `${match[1]}-${match[2]}-${match[3]}`,
    minutes: hours * 60 + minutes,
    dayOfWeek: utcDate.getUTCDay(),
    epochMs: utcDate.getTime(),
  };
}

function hasHkCashMarketOpened(feedTime: ReturnType<typeof parseHkFeedTime>): boolean {
  if (!feedTime) return false;
  const isWeekday = feedTime.dayOfWeek >= 1 && feedTime.dayOfWeek <= 5;
  const continuousTradingStart = 9 * 60 + 30;
  return isWeekday && feedTime.minutes >= continuousTradingStart;
}

export default function HsiPanel({ refreshToken, startupCheck, dataMode = "main" }: HsiPanelProps) {
  const useFutuData = dataMode === "futu";
  const [cbbcView, setCbbcView] = useState<CbbcPresentation>("general");
  const useDetailCbbc = useFutuData && cbbcView === "detail";
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartShotRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<ReturnType<typeof createChart> | null>(null);
  const seriesRef = useRef<
    ReturnType<typeof createChart>["addSeries"] extends (...args: any) => infer R ? R : null
  >(null);
  const moneyflowSeriesRef = useRef<any>(null);
  const moneyflowShortSeriesRef = useRef<any>(null);
  const openInterestSeriesRef = useRef<any>(null);
  const volumeSeriesRef = useRef<any>(null);
  const volumeAverageSeriesRef = useRef<any>(null);
  // Last accepted Futu futures volume per trading day. Intraday futures volume
  // is cumulative, so a transient/stale response must never move it backwards.
  const verifiedVolumeByDateRef = useRef<Map<string, number>>(new Map());
  const hasInitialViewportRef = useRef(false);
  // CBBC price lines, each tagged with its side + knockout level so we can recolor
  // them live (knocked-out = gray) as the real-time price moves.
  const priceLinesRef = useRef<{ line: any; side: "bear" | "bull"; trigger: number }[]>([]);
  // Recolors the CBBC lines for a given real-time high/low. Set by the overlay effect,
  // called by the live-price ticker so knockouts update in real time.
  const recolorCbbcRef = useRef<((high: number | null, low: number | null) => void) | null>(null);
  const cbbcLabelLevelsRef = useRef<{
    side: "bear" | "bull";
    start: number;
    end: number;
    level: number;
    trigger: number;
    volume: number;
  }[]>([]);
  const [cbbcLineLabels, setCbbcLineLabels] = useState<CbbcLineLabel[]>([]);
  const cbbcLineLabelsRef = useRef<CbbcLineLabel[]>([]);
  const cbbcLabelElementsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  // Exact set of candle dates currently on the chart — money flow points must
  // align to these or lightweight-charts inserts a phantom time slot (skipped day).
  const candleTimesRef = useRef<Set<string>>(new Set());
  // Latest candle on the chart — updated in place with the live HSI price so the
  // last bar (and its price line) tracks the market instead of the stale DB close.
  const lastCandleRef = useRef<Candle | null>(null);
  const hasLoadedDataRef = useRef(false);
  // Bumped every time candles are (re)loaded, so money flow reloads even when the
  // date range is unchanged (e.g. a manual refresh on the same trading day).
  const [dataVersion, setDataVersion] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);
  const [staleMessage, setStaleMessage] = useState<string | null>(null);
  const [chartReady, setChartReady] = useState(false);
  const [candleRange, setCandleRange] = useState<{ min: string | null; max: string | null }>({
    min: null,
    max: null,
  });
  const [moneyflowError, setMoneyflowError] = useState<string | null>(null);

  // CBBC knockout alerts. knockedOutRef holds the set of strikes already knocked
  // out; null means "not seeded yet" so the first poll establishes a baseline
  // without firing alerts for levels that were knocked out before you opened the page.
  const knockedOutRef = useRef<Set<string> | null>(null);
  // Bands seen this session, including ones the outstanding feed drops after knockout.
  const cbbcSessionLevelsRef = useRef<CbbcKnockoutLevel[]>([]);
  const [knockoutAlerts, setKnockoutAlerts] = useState<KnockoutAlert[]>([]);
  const [alertsMuted, setAlertsMuted] = useState(false);
  const [manualRefreshVersion, setManualRefreshVersion] = useState(0);
  const [manualRefreshActive, setManualRefreshActive] = useState(false);
  const refreshAllInFlightRef = useRef(false);
  const forceFullRefreshRef = useRef(false);
  const moneyFlowRefreshInFlightRef = useRef(false);
  const moneyFlowLoadInFlightRef = useRef(false);
  const openInterestLoadInFlightRef = useRef(false);
  const componentMountedRef = useRef(false);
  const alertsMutedRef = useRef(false);
  const screenshotToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [screenshotCopied, setScreenshotCopied] = useState(false);
  useEffect(() => { alertsMutedRef.current = alertsMuted; }, [alertsMuted]);

  // Real-time HSI cash feed status. liveStale = the real-time feed isn't updating
  // (poll failing or feed timestamp gone old) — we keep the last value but warn.
  const [liveStale, setLiveStale] = useState(false);
  const [livePrice, setLivePrice] = useState<number | null>(null);
  const [openInterestHistory, setOpenInterestHistory] = useState<Array<{
    date: string;
    value: number;
    source?: string;
  }>>([]);
  // The five-second Futu endpoint persists its open-interest snapshot to SQLite
  // before responding. Bump this after each verified response so the graph reads
  // that newly stored value immediately instead of waiting for a full candle load.
  const [openInterestRefreshVersion, setOpenInterestRefreshVersion] = useState(0);
  const [liveRefreshCountdown, setLiveRefreshCountdown] = useState(0);
  const [liveCbbcPayload, setLiveCbbcPayload] = useState<(CbbcResponse & FutuMarketPayload) | null>(null);
  const [generalCbbcPayload, setGeneralCbbcPayload] = useState<CbbcResponse | null>(null);
  const lastLiveSuccessAtRef = useRef(Date.now());
  const lastLiveRef = useRef<{ high: number | null; low: number | null }>({ high: null, low: null });
  const sessionRangeDateRef = useRef<string | null>(null);

  useEffect(() => {
    componentMountedRef.current = true;
    return () => { componentMountedRef.current = false; };
  }, []);

  const updateCbbcLineLabelPositions = useCallback(() => {
    const series = seriesRef.current as { priceToCoordinate?: (price: number) => number | null } | null;
    if (!series?.priceToCoordinate) return;
    const mainPaneHeight = chartRef.current?.panes()[0]?.getHeight() ?? 0;
    const labelHalfHeight = 7.5;
    // Volume occupies the bottom 20% of pane 0. Keep warrant labels inside the
    // candlestick region so off-scale levels cannot spill into the lower charts.
    const candleRegionBottom = mainPaneHeight * 0.8 - labelHalfHeight;
    const containerWidth = containerRef.current?.clientWidth ?? 0;
    const laneRight = Math.max(0, containerWidth - 112);
    const columnGap = 8;
    const columnWidth = 38;
    const rightColumnX = Math.max(12, laneRight - columnWidth);
    const leftColumnX = Math.max(12, rightColumnX - columnWidth - columnGap);
    const maxVolumeBySide = cbbcLabelLevelsRef.current.reduce(
      (acc, item) => {
        acc[item.side] = Math.max(acc[item.side], item.volume);
        return acc;
      },
      { bear: 1, bull: 1 } as Record<"bear" | "bull", number>
    );
    const { high, low } = lastLiveRef.current;
    const next = cbbcLabelLevelsRef.current
      .map((item) => {
        const y = series.priceToCoordinate?.(item.level);
        if (y === null || y === undefined || !Number.isFinite(y)) return null;
        if (y < labelHalfHeight || y > candleRegionBottom) return null;
        const ratio = Math.min(1, Math.max(0, item.volume / maxVolumeBySide[item.side]));
        const knockedOut = cbbcLevelKnockedOut(item, high, low);
        return {
          key: `${item.side}:${item.level}`,
          side: item.side,
          start: item.start,
          end: item.end,
          level: item.level,
          trigger: item.trigger,
          volume: item.volume,
          x: ratio >= 0.5 ? rightColumnX : leftColumnX,
          y,
          color: colorForCbbcLine(item.side, item.trigger, high, low),
          knockedOut,
        };
      })
      .filter((item): item is CbbcLineLabel => item !== null);

    // Keep the DOM labels on the exact coordinate returned by the price series.
    // Direct style writes avoid the React render / animation-frame delay that
    // otherwise makes labels visibly trail their canvas-rendered price lines.
    const nextKeys = new Set(next.map((item) => item.key));
    cbbcLabelElementsRef.current.forEach((element, key) => {
      if (!nextKeys.has(key)) element.style.display = "none";
    });
    next.forEach((item) => {
      const element = cbbcLabelElementsRef.current.get(item.key);
      if (!element) return;
      element.style.display = "";
      element.style.left = `${item.x}px`;
      element.style.top = `${item.y}px`;
      element.style.backgroundColor = item.color;
    });

    const previous = cbbcLineLabelsRef.current;
    const contentUnchanged = previous.length === next.length && previous.every((item, index) => {
      const candidate = next[index];
      return candidate !== undefined &&
        item.key === candidate.key &&
        item.start === candidate.start &&
        item.end === candidate.end &&
        item.trigger === candidate.trigger &&
        item.volume === candidate.volume &&
        item.color === candidate.color &&
        item.knockedOut === candidate.knockedOut;
    });
    cbbcLineLabelsRef.current = next;
    if (contentUnchanged) return;
    setCbbcLineLabels(next);
  }, []);

  // Loud rising alert via Web Audio (no asset needed). Respects the mute toggle.
  const playKnockoutBeep = useCallback(() => {
    if (alertsMutedRef.current) return;
    try {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new Ctx();
      if (ctx.state === "suspended") ctx.resume();
      const master = ctx.createGain();
      master.gain.value = 1.15;
      master.connect(ctx.destination);

      [0, 0.16, 0.32, 0.48].forEach((offset, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(master);
        osc.type = "square";
        osc.frequency.value = [780, 1040, 1320, 1660][i] ?? 1320;
        const t0 = ctx.currentTime + offset;
        gain.gain.setValueAtTime(0.0001, t0);
        gain.gain.exponentialRampToValueAtTime(0.9, t0 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.23);
        osc.start(t0);
        osc.stop(t0 + 0.25);
      });

      [0, 0.32].forEach((offset) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(master);
        osc.type = "sawtooth";
        osc.frequency.value = 220;
        const t0 = ctx.currentTime + offset;
        gain.gain.setValueAtTime(0.0001, t0);
        gain.gain.exponentialRampToValueAtTime(0.45, t0 + 0.025);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.28);
        osc.start(t0);
        osc.stop(t0 + 0.3);
      });
      setTimeout(() => ctx.close().catch(() => {}), 1200);
    } catch {
      /* audio unavailable — silent */
    }
  }, []);

  // Fire a sample knockout alert so you can confirm sound + visual work.
  const testKnockoutAlert = useCallback(() => {
    playKnockoutBeep();
    const now = Date.now();
    const side: "bear" | "bull" = Math.random() < 0.5 ? "bear" : "bull";
    setKnockoutAlerts((prev) => [
      {
        id: `test:${now}`,
        side,
        price: side === "bear" ? 24800 : 24000,
        volume: 500,
        at: now,
      },
      ...prev,
    ].slice(0, 6));
  }, [playKnockoutBeep]);

  const screenshotHsiChart = useCallback(() => {
    const frame = chartShotRef.current;
    if (!frame) return;

    const bounds = frame.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;

    const ratio = Math.max(1, window.devicePixelRatio || 1);
    const output = document.createElement("canvas");
    output.width = Math.round(bounds.width * ratio);
    output.height = Math.round(bounds.height * ratio);

    const ctx = output.getContext("2d");
    if (!ctx) return;

    ctx.scale(ratio, ratio);
    ctx.fillStyle = getComputedStyle(frame).backgroundColor || "#ffffff";
    ctx.fillRect(0, 0, bounds.width, bounds.height);

    const canvases = Array.from(frame.querySelectorAll("canvas"));
    canvases.forEach((canvas) => {
      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      ctx.drawImage(
        canvas,
        rect.left - bounds.left,
        rect.top - bounds.top,
        rect.width,
        rect.height
      );
    });

    ctx.font = "600 10px Arial, sans-serif";
    ctx.textBaseline = "middle";
    cbbcLineLabelsRef.current.forEach((label) => {
      const text = Math.round(label.volume).toLocaleString("en-US");
      const width = ctx.measureText(text).width + 12;
      const height = 15;
      const x = label.x;
      const y = label.y - height / 2;
      ctx.fillStyle = label.color;
      ctx.fillRect(x, y, width, height);
      ctx.fillStyle = "#ffffff";
      ctx.fillText(text, x + 6, y + height / 2);
    });

    const now = new Date();
    const timestamp = now.toLocaleString("en-HK", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    ctx.font = "700 13px Arial, sans-serif";
    ctx.textBaseline = "top";
    const tagWidth = ctx.measureText(timestamp).width + 18;
    ctx.fillStyle = "rgba(255, 255, 255, 0.92)";
    ctx.fillRect(10, 10, tagWidth, 25);
    ctx.fillStyle = "#111827";
    ctx.fillText(timestamp, 19, 16);

    output.toBlob(async (blob) => {
      if (!blob) return;
      try {
        await navigator.clipboard.write([
          new ClipboardItem({ "image/png": blob }),
        ]);
        setScreenshotCopied(true);
        if (screenshotToastTimerRef.current) {
          clearTimeout(screenshotToastTimerRef.current);
        }
        screenshotToastTimerRef.current = setTimeout(() => {
          setScreenshotCopied(false);
          screenshotToastTimerRef.current = null;
        }, 1800);
      } catch (error) {
        diagError("HSI", "screenshot clipboard write failed", error);
      }
    }, "image/png");
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.metaKey || !event.shiftKey || event.key.toLowerCase() !== "s") return;
      event.preventDefault();
      screenshotHsiChart();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [screenshotHsiChart]);

  useEffect(() => {
    return () => {
      if (screenshotToastTimerRef.current) {
        clearTimeout(screenshotToastTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    diag("HSI", "component mounted", { refreshToken });
  }, [refreshToken]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const chart = createChart(container, {
      width: container.clientWidth,
      height: container.clientHeight,
      layout: {
        background: { type: ColorType.Solid, color: "#ffffff" },
        textColor: "#111827",
      },
      grid: {
        vertLines: { color: "#eef2f7" },
        horzLines: { color: "#eef2f7" },
      },
      rightPriceScale: {
        borderColor: "#e5e7eb",
      },
      timeScale: {
        borderColor: "#e5e7eb",
      },
    });

    chart.applyOptions({
      crosshair: {
        mode: CrosshairMode.Normal,
      },
    });

    // Pane 0: candles + volume
    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: "#26a69a",
      downColor: "#ef5350",
      wickUpColor: "#26a69a",
      wickDownColor: "#ef5350",
      borderVisible: false,
      priceLineStyle: LineStyle.Solid,
    });

    const volumeSeries = chart.addSeries(BaselineSeries, {
      priceScaleId: "volume",
      priceFormat: { type: "volume" },
      baseValue: { type: "price", price: 1 },
      relativeGradient: true,
      topLineColor: "rgba(13,148,136,0.95)",
      topFillColor1: "rgba(13,148,136,0.42)",
      topFillColor2: "rgba(13,148,136,0.05)",
      bottomLineColor: "rgba(220,38,38,0.92)",
      bottomFillColor1: "rgba(220,38,38,0.05)",
      bottomFillColor2: "rgba(220,38,38,0.38)",
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: true,
    });
    chart.priceScale("volume").applyOptions({
      scaleMargins: { top: 0.8, bottom: 0.02 },
      borderVisible: false,
    });
    const volumeAverageSeries = chart.addSeries(LineSeries, {
      priceScaleId: "volume",
      color: "rgba(55,65,81,0.72)",
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
      priceFormat: { type: "volume" },
    });

    // Pane 1: long money flow (好倉資金流)
    chart.addPane();
    chart.panes()[0].setStretchFactor(1);
    chart.panes()[1].setStretchFactor(0.3);

    const moneyflowSeries = chart.addSeries(HistogramSeries, {
      priceScaleId: "right",
      priceFormat: { type: "volume" },
    }, 1);
    chart.panes()[1].priceScale("right").applyOptions({
      borderVisible: false,
      scaleMargins: { top: 0.05, bottom: 0.05 },
    });

    // Pane 2: short money flow (淡倉資金流)
    chart.addPane();
    chart.panes()[2].setStretchFactor(0.3);

    const moneyflowShortSeries = chart.addSeries(HistogramSeries, {
      priceScaleId: "right",
      priceFormat: { type: "volume" },
    }, 2);
    chart.panes()[2].priceScale("right").applyOptions({
      borderVisible: false,
      scaleMargins: { top: 0.05, bottom: 0.05 },
    });

    let openInterestSeries: any = null;
    if (useFutuData) {
      chart.addPane();
      chart.panes()[3].setStretchFactor(0.3);
      openInterestSeries = chart.addSeries(AreaSeries, {
        priceScaleId: "right",
        lineColor: "#7c3aed",
        topColor: "rgba(124,58,237,0.30)",
        bottomColor: "rgba(124,58,237,0.03)",
        lineWidth: 2,
        priceFormat: { type: "volume" },
        lastValueVisible: true,
        priceLineVisible: false,
      }, 3);
      chart.panes()[3].priceScale("right").applyOptions({
        borderVisible: false,
        autoScale: true,
        invertScale: false,
        scaleMargins: { top: 0.12, bottom: 0.12 },
      });
    }

    chartRef.current = chart;
    seriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;
    volumeAverageSeriesRef.current = volumeAverageSeries;
    moneyflowSeriesRef.current = moneyflowSeries;
    moneyflowShortSeriesRef.current = moneyflowShortSeries;
    openInterestSeriesRef.current = openInterestSeries;

    diag("HSI", "chart initialized", {
      width: container.clientWidth,
      height: container.clientHeight,
      chartReady: true,
    });
    setChartReady(true);

    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      chart.applyOptions({ width, height });
      updateCbbcLineLabelPositions();
      if (width === 0 || height === 0) {
        diag("HSI", "chart resized to zero", { width, height });
      }
    });

    resizeObserver.observe(container);
    const handleVisibleRangeChange = () => {
      updateCbbcLineLabelPositions();
      const range = chart.timeScale().getVisibleLogicalRange();
      if (hasInitialViewportRef.current && range && Number.isFinite(range.from) && Number.isFinite(range.to)) {
        try {
          window.localStorage.setItem(
            `hsi-chart-viewport:${useFutuData ? "futu" : "main"}`,
            JSON.stringify(range)
          );
        } catch {
          // Viewport persistence is optional.
        }
      }
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(handleVisibleRangeChange);

    return () => {
      resizeObserver.disconnect();
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(handleVisibleRangeChange);
      if (volumeSeriesRef.current) {
        chart.removeSeries(volumeSeriesRef.current);
        volumeSeriesRef.current = null;
      }
      if (volumeAverageSeriesRef.current) {
        chart.removeSeries(volumeAverageSeriesRef.current);
        volumeAverageSeriesRef.current = null;
      }
      if (moneyflowSeriesRef.current) {
        chart.removeSeries(moneyflowSeriesRef.current);
        moneyflowSeriesRef.current = null;
      }
      if (moneyflowShortSeriesRef.current) {
        chart.removeSeries(moneyflowShortSeriesRef.current);
        moneyflowShortSeriesRef.current = null;
      }
      if (openInterestSeriesRef.current) {
        chart.removeSeries(openInterestSeriesRef.current);
        openInterestSeriesRef.current = null;
      }
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      priceLinesRef.current = [];
      cbbcLabelLevelsRef.current = [];
      cbbcLineLabelsRef.current = [];
      cbbcLabelElementsRef.current.clear();
      hasInitialViewportRef.current = false;
      setCbbcLineLabels([]);
      setChartReady(false);
    };
  }, [updateCbbcLineLabelPositions, useFutuData]);

  useEffect(() => {
    const controller = new AbortController();
    let isMounted = true;

    async function loadData() {
      try {
        if (!hasLoadedDataRef.current) setIsLoading(true);
        setHasError(false);
        // Cache-bust so a manual refresh / auto-refresh always re-hits the server
        // for the latest daily bar instead of the browser's 5-min HTTP cache.
        const forceFullRefresh = useFutuData && forceFullRefreshRef.current;
        forceFullRefreshRef.current = false;
        const fetchUrl = useFutuData
          ? `/api/futu/market-data?${forceFullRefresh ? "refresh=1&" : ""}_=${refreshToken}-${manualRefreshVersion}`
          : `/api/hsi?years=5&_=${refreshToken}-${manualRefreshVersion}`;
        diag("HSI", "fetch start", { url: fetchUrl, refreshToken });

        const response = await fetch(fetchUrl, { signal: controller.signal, cache: "no-store" });
        if (!response.ok) {
          throw new Error("Failed to fetch data");
        }

        const responseData = (await response.json()) as ApiResponse | FutuMarketPayload;
        const futuPayload = useFutuData ? responseData as FutuMarketPayload : null;
        const rawData: ApiResponse & { candles?: Candle[] } = useFutuData
          ? {
              symbol: "HK.800000",
              candles: ((futuPayload?.candles) || []).map((bar) => ({
                ...bar,
                time: bar.date,
                // Zero/missing volume is not a real observation. Omitting it is
                // safer than drawing a false collapse to zero.
                volume: isPositiveNumber(Number(bar.volume)) ? Number(bar.volume) : undefined,
              })),
            }
          : responseData as ApiResponse;
        const data: ApiResponse = {
          symbol: rawData.symbol ?? "^HSI",
          candles: Array.isArray(rawData.candles) ? rawData.candles : [],
        };
        const serverCandles = Array.isArray(data.candles) ? data.candles : [];
        // A history refresh can legitimately lag the live feed by one session.
        // Keep the already-rendered in-progress candle in the replacement set so
        // setData never removes it before the next live tick puts it back.
        const currentLiveCandle = lastCandleRef.current;
        const candles = [...serverCandles];
        if (currentLiveCandle?.time === hkToday()) {
          const verifiedLiveVolume = verifiedVolumeByDateRef.current.get(currentLiveCandle.time);
          const preservedLiveCandle = isPositiveNumber(verifiedLiveVolume)
            ? { ...currentLiveCandle, volume: verifiedLiveVolume }
            : currentLiveCandle;
          const index = candles.findIndex((candle) => candle.time === preservedLiveCandle.time);
          if (index >= 0) candles[index] = preservedLiveCandle;
          else if (!candles.at(-1) || preservedLiveCandle.time > candles.at(-1)!.time) candles.push(preservedLiveCandle);
        }
        const latest = candles.length > 0 ? candles[candles.length - 1].time : null;
        diag("HSI", "fetch success", {
          status: response.status,
          symbol: data.symbol,
          candles: candles.length,
          first: candles[0] ?? null,
          last: candles[candles.length - 1] ?? null,
          source: (data as ApiResponse & { source?: string }).source ?? null,
        });

        if (isMounted && seriesRef.current) {
          const timeScale = chartRef.current?.timeScale();
          const currentRange = hasInitialViewportRef.current
            ? timeScale?.getVisibleLogicalRange() ?? null
            : null;
          seriesRef.current.setData(candles);
          if (volumeSeriesRef.current) {
            const volPoints = candles
              .map((c) => {
                const vol = Number(c.volume);
                if (!c.time || !isPositiveNumber(vol)) return null;
                const previous = verifiedVolumeByDateRef.current.get(c.time);
                // Only today's cumulative reading is expected to change. Keep the
                // highest verified value if refreshes race or a stale cache arrives.
                const value = c.time === hkToday() && isPositiveNumber(previous)
                  ? Math.max(previous, vol)
                  : vol;
                verifiedVolumeByDateRef.current.set(c.time, value);
                return {
                  time: c.time,
                  value,
                };
              })
              .filter((p): p is { time: string; value: number } => p !== null);
            if (volumeAverageSeriesRef.current) {
              const averagePoints = volPoints.map((point, index) => {
                const window = volPoints.slice(Math.max(0, index - 19), index + 1).map((item) => item.value);
                if (window.length < 5) return null;
                return { time: point.time, value: window.reduce((sum, value) => sum + value, 0) / window.length };
              }).filter((point): point is { time: string; value: number } => point !== null);
              const currentBaseline = averagePoints.at(-1)?.value;
              if (Number.isFinite(currentBaseline)) {
                // Apply the baseline before replacing the points. Doing this after
                // setData caused a visible down/up rescale on every refresh.
                volumeSeriesRef.current.applyOptions({
                  baseValue: { type: "price", price: currentBaseline },
                });
              }
              volumeAverageSeriesRef.current.setData(averagePoints);
            }
            volumeSeriesRef.current.setData(volPoints);
            diag("HSI", "volume series updated", {
              points: volPoints.length,
              first: volPoints[0] ?? null,
              last: volPoints[volPoints.length - 1] ?? null,
            });
          }
          const times = candles.map((c) => c.time).filter((t) => typeof t === "string");
          times.sort();
          candleTimesRef.current = new Set(times);
          lastCandleRef.current = candles.length > 0 ? candles[candles.length - 1] : null;
          const todayBar = lastCandleRef.current;
          if (todayBar && todayBar.time === hkToday()) {
            const range = applyIntradayRange(lastLiveRef, sessionRangeDateRef, todayBar.time, todayBar.high, todayBar.low);
            recolorCbbcRef.current?.(range.high, range.low);
            updateCbbcLineLabelPositions();
          }
          setCandleRange({
            min: times.length > 0 ? times[0] : null,
            max: times.length > 0 ? times[times.length - 1] : null,
          });
          setDataVersion((v) => v + 1); // trigger money flow reload (even if range unchanged)
          if (timeScale) {
            let targetRange = currentRange;
            if (!targetRange) {
              try {
                const saved = JSON.parse(
                  window.localStorage.getItem(`hsi-chart-viewport:${useFutuData ? "futu" : "main"}`) ?? "null"
                ) as { from?: number; to?: number } | null;
                if (Number.isFinite(saved?.from) && Number.isFinite(saved?.to)) {
                  targetRange = {
                    from: Number(saved?.from) as Logical,
                    to: Number(saved?.to) as Logical,
                  };
                }
              } catch {
                // Fall through to the initial fit.
              }
            }
            try {
              if (targetRange) timeScale.setVisibleLogicalRange(targetRange);
              else timeScale.fitContent();
            } catch {
              timeScale.fitContent();
            }
            hasInitialViewportRef.current = true;
          }
          diag("HSI", "candles applied to chart", {
            candles: candles.length,
            candleRange: {
              min: times.length > 0 ? times[0] : null,
              max: times.length > 0 ? times[times.length - 1] : null,
            },
            latest,
          });
          if (futuPayload?.stale) {
            setStaleMessage(null);
          } else if (latest) {
            const latestDate = new Date(`${latest}T00:00:00Z`);
            const now = new Date();
            const nowUtc = Date.UTC(
              now.getUTCFullYear(),
              now.getUTCMonth(),
              now.getUTCDate()
            );
            const diffDays = Math.floor((nowUtc - latestDate.getTime()) / 86400000);
            if (!Number.isNaN(diffDays) && diffDays > 7) {
              setStaleMessage(
                `Data looks stale (latest: ${latest}). Source may be outdated or wrong symbol.`
              );
            } else {
              setStaleMessage(null);
            }
          } else {
            setStaleMessage(null);
          }
          setIsLoading(false);
          hasLoadedDataRef.current = true;
          refreshAllInFlightRef.current = false;
          setManualRefreshActive(false);
        }
      } catch (error) {
        if (!isMounted || controller.signal.aborted) return;
        setHasError(true);
        setIsLoading(false);
        refreshAllInFlightRef.current = false;
        setManualRefreshActive(false);
        diagError("HSI", "fetch failed", error);
      }
    }

    loadData();

    return () => {
      isMounted = false;
      controller.abort();
    };
  }, [refreshToken, manualRefreshVersion, useFutuData]);

  // The Futu market-data page does not run the main dashboard's startup check.
  // Refresh the external money-flow source here so this page does not keep
  // displaying yesterday's database snapshot indefinitely. Repeating the fetch
  // also catches providers that publish the completed session after this page
  // was opened.
  useEffect(() => {
    if (!useFutuData) return;

    const refreshMoneyFlow = async () => {
      if (moneyFlowRefreshInFlightRef.current) return;
      moneyFlowRefreshInFlightRef.current = true;
      try {
        const response = await fetch("/api/moneyflow/refresh", {
          method: "POST",
          cache: "no-store",
        });
        const result = await response.json().catch(() => ({})) as {
          error?: string;
          long_rows?: number;
          short_rows?: number;
          long_latest_date?: string | null;
          short_latest_date?: string | null;
        };

        if (!response.ok && response.status !== 429) {
          throw new Error(result.error || `Money flow refresh failed (HTTP ${response.status})`);
        }
        if (!componentMountedRef.current) return;

        // A cooldown response still means another request just refreshed the DB;
        // reload the stored rows in either case.
        setDataVersion((version) => version + 1);
        diag("HSI", "money flow source refreshed", {
          status: response.status,
          longRows: result.long_rows,
          shortRows: result.short_rows,
          longLatestDate: result.long_latest_date,
          shortLatestDate: result.short_latest_date,
        });
      } catch (error) {
        if (componentMountedRef.current) {
          // Keep the last verified DB rows visible and retry later.
          diagError("HSI", "money flow source refresh failed", error);
        }
      } finally {
        moneyFlowRefreshInFlightRef.current = false;
      }
    };

    void refreshMoneyFlow();
  }, [manualRefreshVersion, useFutuData]);

  // Real-time HSI cash ticker: poll the live cash feed every 5s. Updates the chart's
  // last candle in place (daily view) and records the intraday high/low for knockout
  // detection. If the feed stops being real-time, flag it stale (we keep the last
  // value rather than silently dropping to delayed data).
  useEffect(() => {
    // The Futu page must not mix a Tencent quote into a chart explicitly labelled
    // as Futu. Its dedicated OpenD poll below is the sole live source in that mode.
    if (!chartReady || useFutuData) return;
    let cancelled = false;
    let inFlight = false;

    const tick = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        // Use the dedicated real-time cash-index endpoint for both views. The Futu
        // bridge also fetches warrants and can take longer than five seconds, which
        // made the visible HSI price appear frozen even while the poll was running.
        const res = await fetch(`/api/hsi/live?_=${Date.now()}`, { cache: "no-store" });
        if (!res.ok) { if (!cancelled) setLiveStale(true); return; }
        const liveData = (await res.json()) as FutuMarketPayload & {
          ok?: boolean; price?: number; open?: number | null; high?: number | null; low?: number | null; realtime?: boolean; time?: string;
        };
        const j = liveData;
        if (cancelled) return;
        if (!j.ok || typeof j.price !== "number" || !Number.isFinite(j.price)) { setLiveStale(true); return; }

        // The badge shows the age of the last valid live payload. Update it as soon
        // as the feed succeeds; chart mutation can legitimately be skipped before
        // the market opens and must not leave the clock frozen at zero.
        lastLiveSuccessAtRef.current = Date.now();

        // The feed's `time` is HK local ("YYYY/MM/DD HH:mm:ss"); its date is today's
        // HK trading day. We use it to decide whether the live tick belongs to the
        // last bar on the chart or to a brand-new (in-progress) day.
        const liveTime = parseHkFeedTime(j.time);
        const liveDate = liveTime?.date ?? null;

        setLiveStale(!j.realtime);            // feed up but timestamp old → warn
        setLivePrice(j.price);
        const liveHigh = isPositiveNumber(j.high) ? j.high : null;
        const liveLow = isPositiveNumber(j.low) ? j.low : null;
        const range = applyIntradayRange(lastLiveRef, sessionRangeDateRef, liveDate, liveHigh, liveLow);
        // Recolor CBBC knockout lines against the session high/low, including a
        // high already printed on today's candle before this tick arrived.
        recolorCbbcRef.current?.(range.high, range.low);
        updateCbbcLineLabelPositions();

        // Rebuild today's candle from the feed's authoritative OHLC. We do NOT mix in
        // the DB bar's high/low — the DB's placeholder today-bar can carry a bogus low
        // (e.g. yesterday's close), which would leave a fake wick. The live feed is the
        // source of truth for today's open/high/low/last.
        const last = lastCandleRef.current;
        if (seriesRef.current && last) {
          // If the feed's trading day is newer than the last candle on the chart, the
          // daily history hasn't produced today's bar yet (normal mid-session). APPEND
          // a fresh bar for today instead of overwriting yesterday's close — otherwise
          // the previous day's candle gets dragged to the live price and today is
          // skipped entirely.
          if (liveDate !== null && liveDate < last.time) return;
          const isNewDay = liveDate !== null && liveDate > last.time;
          const marketOpened = hasHkCashMarketOpened(liveTime);
          const liveOpen = isPositiveNumber(j.open) ? j.open : null;

          if (isNewDay && (!marketOpened || liveOpen === null)) {
            return;
          }

          const open = liveOpen ?? Number(last.open);
          if (!isPositiveNumber(open)) return;

          const high = liveHigh !== null ? Math.max(liveHigh, j.price, open) : Math.max(j.price, open);
          const low = liveLow !== null ? Math.min(liveLow, j.price, open) : Math.min(j.price, open);
          if (!isPositiveNumber(high) || !isPositiveNumber(low) || low > high) return;

          const updated: Candle = {
            time: isNewDay ? (liveDate as string) : last.time,
            open,
            high,
            low,
            close: j.price,
            // A new in-progress day has no settled volume yet; don't carry yesterday's.
            volume: isNewDay ? undefined : last.volume,
          };
          seriesRef.current.update(updated);
          lastCandleRef.current = updated;
          if (isNewDay) {
            candleTimesRef.current.add(updated.time);
          }
        }
      } catch {
        if (!cancelled) setLiveStale(true);
      } finally {
        inFlight = false;
      }
    };

    void tick();
    const id = window.setInterval(() => { void tick(); }, 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [chartReady, updateCbbcLineLabelPositions, useFutuData]);

  useEffect(() => {
    if (!useFutuData) return;
    setLiveRefreshCountdown(5);
    const id = window.setInterval(() => {
      setLiveRefreshCountdown((seconds) => seconds <= 1 ? 5 : seconds - 1);
    }, 1_000);
    return () => window.clearInterval(id);
  }, [manualRefreshVersion, useFutuData]);

  // Required behavior: reload the complete data pipeline every five seconds.
  // The chart preserves its logical viewport across setData, while the fixed-size
  // toolbar/footer prevent loading state from changing the panel geometry.
  useEffect(() => {
    if (!useFutuData) return;
    const id = window.setInterval(() => {
      if (refreshAllInFlightRef.current) return;
      refreshAllInFlightRef.current = true;
      setManualRefreshActive(true);
      setManualRefreshVersion((version) => version + 1);
      window.dispatchEvent(new CustomEvent("market-data:refresh-all"));
    }, 5_000);
    return () => window.clearInterval(id);
  }, [useFutuData]);

  useEffect(() => {
    if (!useFutuData || !chartReady || dataVersion === 0) return;
    if (openInterestLoadInFlightRef.current) return;
    const loadHistoricalOpenInterest = async () => {
      openInterestLoadInFlightRef.current = true;
      try {
        const response = await fetch(`/api/hkex/open-interest?_=${Date.now()}`, {
          cache: "no-store",
        });
        if (!response.ok) return;
        const payload = (await response.json()) as {
          rows?: Array<{ date?: string; value?: number; source?: string }>;
        };
        if (!componentMountedRef.current) return;
        setOpenInterestHistory(
          (payload.rows ?? [])
            .filter((item): item is { date: string; value: number; source?: string } =>
              typeof item.date === "string" && isPositiveNumber(item.value)
            )
            .sort((a, b) => a.date.localeCompare(b.date))
        );
      } catch {
        // Keep Futu's live OI visible even if the HKEX history request is unavailable.
      } finally {
        openInterestLoadInFlightRef.current = false;
      }
    };
    loadHistoricalOpenInterest();
  }, [chartReady, dataVersion, openInterestRefreshVersion, useFutuData]);

  useEffect(() => {
    if (!useFutuData || !openInterestSeriesRef.current || !candleRange.max) return;
    const aligned = openInterestHistory
      .filter((item) => candleTimesRef.current.has(item.date))
      .map((item) => ({
        time: item.date,
        value: item.value,
        source: item.source,
      }))
      .sort((a, b) => a.time.localeCompare(b.time));
    const officialPoints = aligned
      .filter((item) => item.source === "HKEX HSI Futures Daily Market Reports")
      .map(({ time, value }) => ({ time, value }));
    // The graph is intentionally rendered only from the SQL-backed history
    // endpoint. Futu snapshots are persisted server-side before this read, so a
    // provider response can never bypass the database and become chart state.
    // HKEX all-contract totals form the continuous purple line. Futu HSImain is
    // a different, rolling main-contract metric, so it is displayed separately
    // in the live amber readout rather than connected into this series.
    openInterestSeriesRef.current.setData(officialPoints);
  }, [candleRange.max, openInterestHistory, useFutuData]);

  const clearCbbcOverlay = useCallback(() => {
    priceLinesRef.current.forEach((item) => {
      try {
        seriesRef.current?.removePriceLine(item.line);
      } catch {
        /* already removed with the chart */
      }
    });
    priceLinesRef.current = [];
    cbbcLabelLevelsRef.current = [];
    cbbcLineLabelsRef.current = [];
    cbbcLabelElementsRef.current.clear();
    recolorCbbcRef.current = null;
    setCbbcLineLabels([]);
  }, []);

  // Start a fresh KO baseline only when the trading session, data source, or
  // CBBC presentation changes. Ordinary data refreshes must preserve the
  // previous set so newly crossed levels can be detected on the next poll.
  useEffect(() => {
    knockedOutRef.current = null;
    cbbcSessionLevelsRef.current = readStoredCbbcLevels(useFutuData && cbbcView === "detail");
  }, [candleRange.max, useFutuData, cbbcView]);

  useEffect(() => {
    if (!useFutuData) return;
    clearCbbcOverlay();
    setKnockoutAlerts([]);
  }, [cbbcView, clearCbbcOverlay, useFutuData]);

  // Live price and knockout checks. The cash tick must not wait on the CBBC
  // outstanding feed: a slow or hung band refresh was leaving the price frozen.
  useEffect(() => {
    if (!chartReady) return;
    let cancelled = false;
    let priceInFlight = false;
    let bandsInFlight = false;

    const evaluateKnockouts = (liveHigh: number | null, liveLow: number | null) => {
      const levels = cbbcSessionLevelsRef.current;
      if (liveHigh === null || liveLow === null || levels.length === 0) return;
      // A level alerts only when cash reaches its drawn line. The first poll
      // only records the baseline.
      const { now, newly } = newlyKnockedOutLevels(levels, knockedOutRef.current, liveHigh, liveLow);
      if (cancelled) return;
      if (knockedOutRef.current === null) {
        knockedOutRef.current = now;
        return;
      }
      knockedOutRef.current = now;
      if (newly.length === 0) return;
      playKnockoutBeep();
      const nowMs = Date.now();
      setKnockoutAlerts((prev) => [
        ...newly.map((level) => ({
          id: `${level.side}:${level.price}:${nowMs}`,
          side: level.side,
          price: level.trigger,
          start: level.start,
          end: level.end,
          volume: Number.isFinite(level.volume) ? level.volume : 0,
          at: nowMs,
        })),
        ...prev,
      ].slice(0, 6));
    };

    const refreshOutstandingBands = async () => {
      if (useDetailCbbc || bandsInFlight) return;
      bandsInFlight = true;
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 8_000);
      try {
        const generalRes = await fetch(`/api/cbbc/latest?_=${Date.now()}`, { cache: "no-store", signal: controller.signal });
        if (cancelled || !generalRes.ok) return;
        const generalData = (await generalRes.json()) as CbbcResponse;
        if (cancelled) return;
        setGeneralCbbcPayload(generalData);
        const incoming = rowsToCbbcLevels(generalData);
        if (incoming.length > 0) {
          cbbcSessionLevelsRef.current = mergeCbbcLevels(cbbcSessionLevelsRef.current, incoming);
          writeStoredCbbcLevels(false, cbbcSessionLevelsRef.current);
        }
        evaluateKnockouts(lastLiveRef.current.high, lastLiveRef.current.low);
      } catch {
        /* keep the last bands and the last price */
      } finally {
        window.clearTimeout(timer);
        bandsInFlight = false;
      }
    };

    const check = async () => {
      if (priceInFlight) return;
      priceInFlight = true;
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 4_000);
      try {
        let liveHigh = lastLiveRef.current.high;
        let liveLow = lastLiveRef.current.low;

        const futuRes = useFutuData
          ? await fetch(`/api/futu/market-data?live=1&_=${Date.now()}`, { cache: "no-store", signal: controller.signal })
          : null;
        if (cancelled) return;
        const responseData = futuRes && futuRes.ok
          ? ((await futuRes.json()) as CbbcResponse & FutuMarketPayload)
          : null;
        if (cancelled) return;
        // The API may return the last verified full snapshot during an OpenD
        // outage. It is valid historical data, but must never be promoted as a
        // fresh live tick, CBBC update, or cumulative-volume observation.
        const futuStale = Boolean(useFutuData && responseData && (responseData.stale || responseData.liveUnavailable));
        if (futuStale) {
          setLiveStale(true);
          if (useDetailCbbc) return;
        }
        if (useFutuData && responseData?.snapshots && !futuStale) {
          window.dispatchEvent(new CustomEvent("market-data:futu-snapshots", { detail: responseData.snapshots }));
          setOpenInterestRefreshVersion((version) => version + 1);
        }
        // The same five-second response that drives KO detection must also drive
        // the visible warrant lines/volumes. Previously it was discarded after
        // alert calculation, leaving the chart frozen at its initial snapshot.
        if (responseData && !futuStale) setLiveCbbcPayload(responseData);
        const cashSnapshot = responseData?.snapshots?.["HK.800000"];
        if (useFutuData && !futuStale && cashSnapshot && isPositiveNumber(cashSnapshot.price)) {
          const cashFeedTime = parseHkFeedTime(cashSnapshot.updateTime);
          const cashAgeSeconds = cashFeedTime
            ? (Date.now() - cashFeedTime.epochMs) / 1000
            : Infinity;
          const cashRealtime = cashAgeSeconds >= -5 && cashAgeSeconds < 120;
          setLiveStale(!cashRealtime);
          if (!cashRealtime && useDetailCbbc) return;
          if (cashRealtime) {
            // Futu OpenD is the sole source for the Futu view's live badge, OHLC,
            // knockout range, and current cash-index candle.
            setLivePrice(cashSnapshot.price);
            lastLiveSuccessAtRef.current = Date.now();
            const high = isPositiveNumber(cashSnapshot.high) ? cashSnapshot.high : null;
            const low = isPositiveNumber(cashSnapshot.low) ? cashSnapshot.low : null;
            const range = applyIntradayRange(lastLiveRef, sessionRangeDateRef, cashSnapshot.updateTime?.slice(0, 10), high, low);
            liveHigh = range.high;
            liveLow = range.low;

            // Move today's candle before any warrant-label work. A label failure
            // must not leave the chart price sitting on the previous tick.
            const last = lastCandleRef.current;
            const liveDate = cashSnapshot.updateTime?.slice(0, 10);
            if (seriesRef.current && last && liveDate) {
              const isNewDay = liveDate > last.time;
              if (liveDate >= last.time) {
                const open = isPositiveNumber(cashSnapshot.open) ? cashSnapshot.open : Number(last.open);
                if (isPositiveNumber(open)) {
                  const updated: Candle = {
                    time: isNewDay ? liveDate : last.time,
                    open,
                    high: high !== null ? Math.max(high, cashSnapshot.price, open) : Math.max(cashSnapshot.price, open),
                    low: low !== null ? Math.min(low, cashSnapshot.price, open) : Math.min(cashSnapshot.price, open),
                    close: cashSnapshot.price,
                    volume: isNewDay ? undefined : last.volume,
                  };
                  seriesRef.current.update(updated);
                  lastCandleRef.current = updated;
                  if (isNewDay) candleTimesRef.current.add(updated.time);
                }
              }
            }
            const futuresSnapshot = responseData?.snapshots?.["HK.HSImain"];
            if (futuresSnapshot) {
              const liveVolumeDate = futuresSnapshot.updateTime?.slice(0, 10);
              const nextVolume = Number(futuresSnapshot.volume);
              const previousVolume = liveVolumeDate ? verifiedVolumeByDateRef.current.get(liveVolumeDate) : undefined;
              if (
                volumeSeriesRef.current &&
                liveVolumeDate &&
                liveVolumeDate === cashSnapshot.updateTime?.slice(0, 10) &&
                isPositiveNumber(nextVolume) &&
                (!isPositiveNumber(previousVolume) || nextVolume >= previousVolume)
              ) {
                verifiedVolumeByDateRef.current.set(liveVolumeDate, nextVolume);
                volumeSeriesRef.current.update({
                  time: liveVolumeDate,
                  value: nextVolume,
                });
              }
            }
            recolorCbbcRef.current?.(range.high, range.low);
            updateCbbcLineLabelPositions();
          }
        }
        if (useDetailCbbc && responseData) {
          const incoming = rowsToCbbcLevels(adaptFutuCbbc(responseData));
          if (incoming.length > 0) {
            cbbcSessionLevelsRef.current = mergeCbbcLevels(cbbcSessionLevelsRef.current, incoming);
            writeStoredCbbcLevels(true, cbbcSessionLevelsRef.current);
          }
        }

        evaluateKnockouts(liveHigh, liveLow);
      } catch {
        /* ignore transient poll errors */
      } finally {
        window.clearTimeout(timer);
        priceInFlight = false;
      }
    };

    void check();
    void refreshOutstandingBands();
    const priceTimer = window.setInterval(() => {
      void check();
    }, 5_000);
    const bandTimer = window.setInterval(() => {
      void refreshOutstandingBands();
    }, 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(priceTimer);
      window.clearInterval(bandTimer);
    };
  }, [candleRange.max, chartReady, playKnockoutBeep, updateCbbcLineLabelPositions, useDetailCbbc, useFutuData]);

  useEffect(() => {
    if (!chartReady || !seriesRef.current) return;

    const controller = new AbortController();
    let cancelled = false;

    // General CBBC draws each 100-point band on the boundary outside the bucket.
    // Bull 24,200-24,299 sits at 24,199 and is knocked out only when cash prints
    // that line. Bear bands use end + 1 the same way. Detail uses exact Futu
    // recovery prices via adaptFutuCbbc.
    const loadCbbcOverlay = async () => {
      try {
        let responseData: CbbcResponse & FutuMarketPayload;
        if (useDetailCbbc && liveCbbcPayload) {
          responseData = liveCbbcPayload;
        } else if (!useDetailCbbc && generalCbbcPayload) {
          responseData = generalCbbcPayload as CbbcResponse & FutuMarketPayload;
        } else {
          const res = await fetch(useDetailCbbc ? "/api/futu/market-data?live=1" : "/api/cbbc/latest", { signal: controller.signal, cache: "no-store" });
          if (!res.ok) return;
          responseData = (await res.json()) as CbbcResponse & FutuMarketPayload;
        }
        const data = useDetailCbbc ? adaptFutuCbbc(responseData) : responseData;
        const bears = Array.isArray(data?.bearRows) ? data.bearRows : [];
        const bulls = Array.isArray(data?.bullRows) ? data.bullRows : [];
        if (cancelled || !seriesRef.current) return;
        // A transient empty response must not blank the last verified overlay.
        if (bears.length === 0 && bulls.length === 0) return;

        const currentLevels = rowsToCbbcLevels({ bearRows: bears, bullRows: bulls });
        // Both presentations drop a level from the live feed as soon as it knocks
        // out. Keep the session registry so the line can turn gray and the alert
        // can still see it. The date-scoped key starts a fresh registry each day.
        const remembered = cbbcSessionLevelsRef.current.length > 0
          ? cbbcSessionLevelsRef.current
          : readStoredCbbcLevels(useDetailCbbc);
        const picked = mergeCbbcLevels(remembered, currentLevels);
        cbbcSessionLevelsRef.current = picked;
        writeStoredCbbcLevels(useDetailCbbc, picked);

        // Initial colors from whatever real-time high/low we have so far.
        const high0 = lastLiveRef.current.high;
        const low0 = lastLiveRef.current.low;
        cbbcLabelLevelsRef.current = picked.map((lvl) => ({
          side: lvl.side,
          start: lvl.start,
          end: lvl.end,
          level: lvl.price,
          trigger: lvl.trigger,
          volume: lvl.volume,
        }));
        const maxVolumeBySide = picked.reduce(
          (acc, lvl) => {
            acc[lvl.side] = Math.max(acc[lvl.side], lvl.volume);
            return acc;
          },
          { bear: 0, bull: 0 } as Record<"bear" | "bull", number>
        );
        // Reconcile price lines in place. Removing every line before recreating it
        // made the overlay visibly flash on each five-second live response.
        const existingLines = new Map<string, (typeof priceLinesRef.current)[number]>();
        priceLinesRef.current.forEach((item) => {
          existingLines.set(`${item.side}:${item.trigger}`, item);
        });
        const nextPriceLines: typeof priceLinesRef.current = [];
        picked.forEach((lvl) => {
          if (!seriesRef.current || !Number.isFinite(lvl.price)) return;
          const key = `${lvl.side}:${lvl.trigger}`;
          const lineOptions = {
            price: lvl.price,
            color: colorForCbbcLine(lvl.side, lvl.trigger, high0, low0),
            lineWidth: cbbcLineWidth(lvl.volume, maxVolumeBySide[lvl.side]),
            lineStyle: LineStyle.Dotted,
            axisLabelVisible: false,
            title: "",
          };
          const existing = existingLines.get(key);
          if (existing) {
            existing.line.applyOptions(lineOptions);
            nextPriceLines.push(existing);
            existingLines.delete(key);
            return;
          }
          const line = seriesRef.current.createPriceLine(lineOptions);
          if (line) nextPriceLines.push({ line, side: lvl.side, trigger: lvl.trigger });
        });
        // Add replacements first, then remove levels that genuinely disappeared.
        existingLines.forEach((item) => {
          try {
            seriesRef.current?.removePriceLine(item.line);
          } catch {
            /* already removed with the chart */
          }
        });
        priceLinesRef.current = nextPriceLines;
        updateCbbcLineLabelPositions();

        // Expose a recolor hook so the live-price ticker can update knockouts in real time.
        recolorCbbcRef.current = (high, low) => {
          priceLinesRef.current.forEach((item) => {
            try {
              item.line.applyOptions({ color: colorForCbbcLine(item.side, item.trigger, high, low) });
            } catch {
              /* noop */
            }
          });
          updateCbbcLineLabelPositions();
        };

        diag("HSI", "CBBC overlay updated", {
          bearRows: bears.length,
          bullRows: bulls.length,
          pickedLevels: picked.length,
          high0, low0,
        });
      } catch (error) {
        if (controller.signal.aborted) return;
        // Ignore CBBC overlay failures to keep the base chart usable
        diagError("HSI", "CBBC overlay failed", error);
      }
    };

    loadCbbcOverlay();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [chartReady, cbbcView, generalCbbcPayload, liveCbbcPayload, manualRefreshVersion, updateCbbcLineLabelPositions, useDetailCbbc]);

  const loadMoneyFlow = useCallback(
    async (signal?: AbortSignal) => {
      if (!chartReady || !moneyflowSeriesRef.current || !candleRange.min || !candleRange.max) {
        return false;
      }

      const min = candleRange.min;
      const max = candleRange.max;

      // Convert a daily row to a {time, value} point, filtering to candle range
      const toDailyPoints = (rows: MoneyFlowRow[]) =>
        rows
          .map((row) => {
            const dateStr = typeof row?.date === "string" ? row.date.slice(0, 10) : "";
            const val = Number(row?.money_flow_million);
            if (!dateStr || !Number.isFinite(val)) return null;
            return { time: dateStr, value: val };
          })
          .filter((p): p is { time: string; value: number } => p !== null)
          .filter((p) => p.time >= min && p.time <= max)
          .sort((a, b) => a.time.localeCompare(b.time));

      // For the daily view, only keep points whose date is an actual candle on the
      // chart. A money flow date with no matching candle would create a phantom
      // column in lightweight-charts (the "skipped day" bug).
      const alignToCandles = (pts: { time: string; value: number }[]) =>
        pts.filter((p) => candleTimesRef.current.has(p.time));

      const coloriseLong = (pts: { time: string; value: number }[]) =>
        pts.map((p) => ({ ...p, color: p.value >= 0 ? "#1e88e5" : "#c62828" }));
      const coloriseShort = (pts: { time: string; value: number }[]) =>
        pts.map((p) => ({ ...p, color: p.value >= 0 ? "#c62828" : "#1e88e5" }));

      const [longRes, shortRes] = await Promise.all([
        fetch("/api/moneyflow/long", { signal, cache: "no-store" }),
        fetch("/api/moneyflow/short", { signal, cache: "no-store" }),
      ]);

      if (!longRes.ok) throw new Error(`Failed to load long money flow (HTTP ${longRes.status})`);
      if (!moneyflowSeriesRef.current) return false;

      const longData = (await longRes.json()) as MoneyFlowResponse;
      const longDaily = toDailyPoints(Array.isArray(longData?.rows) ? longData.rows : []);
      const longPoints = coloriseLong(alignToCandles(longDaily));
      moneyflowSeriesRef.current.setData(longPoints);

      if (shortRes.ok && moneyflowShortSeriesRef.current) {
        const shortData = (await shortRes.json()) as MoneyFlowResponse;
        const shortDaily = toDailyPoints(Array.isArray(shortData?.rows) ? shortData.rows : []);
        const shortPoints = coloriseShort(alignToCandles(shortDaily));
        moneyflowShortSeriesRef.current.setData(shortPoints);
      }

      diag("HSI", "money flow updated", { longPoints: longPoints.length, interval: "1d" });
      return true;
    },
    [chartReady, candleRange.max, candleRange.min]
  );

  // Reload money flow whenever candles are (re)loaded — keyed on dataVersion so it
  // fires even when the date range is unchanged (manual refresh on the same day).
  useEffect(() => {
    if (!chartReady || !moneyflowSeriesRef.current || dataVersion === 0) return;
    if (moneyFlowLoadInFlightRef.current) return;

    let cancelled = false;

    setMoneyflowError(null);
    moneyFlowLoadInFlightRef.current = true;
    loadMoneyFlow()
      .catch(() => {
        if (cancelled) return;
        setMoneyflowError("Failed to load money flow");
        // Preserve the last verified bars across a transient API failure.
        diag("HSI", "money flow failed", { candleRange });
      })
      .finally(() => {
        moneyFlowLoadInFlightRef.current = false;
      });

    return () => {
      cancelled = true;
    };
  }, [chartReady, dataVersion, loadMoneyFlow]);

  const latestFutuOpenInterest = openInterestHistory
    .filter((item) => item.source === "Futu HK.HSImain snapshot")
    .at(-1);

  const [intradayOpen, setIntradayOpen] = useState(false);
  const closeIntraday = useCallback(() => setIntradayOpen(false), []);

  const statusControls = (
    <>
      <div className="inline-flex items-center rounded-lg bg-[rgba(0,0,0,0.06)] p-[3px] gap-[2px]" role="tablist" aria-label="CBBC presentation">
        {useFutuData ? (
          <>
            <button
              type="button"
              role="tab"
              aria-selected={cbbcView === "general"}
              onClick={() => setCbbcView("general")}
              title="100-point outstanding bands from Backup Data"
              className={`rounded-md px-2.5 py-[3px] text-xs font-semibold ${
                cbbcView === "general" ? "bg-white text-gray-900 shadow-sm" : "text-gray-600 hover:text-gray-900"
              }`}
            >
              General
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={cbbcView === "detail"}
              onClick={() => setCbbcView("detail")}
              title="Exact Futu recovery prices"
              className={`rounded-md px-2.5 py-[3px] text-xs font-semibold ${
                cbbcView === "detail" ? "bg-white text-gray-900 shadow-sm" : "text-gray-600 hover:text-gray-900"
              }`}
            >
              Detail
            </button>
          </>
        ) : (
          <span className="rounded-md bg-white px-3 py-[3px] text-xs font-semibold text-gray-900 shadow-sm">
            Daily
          </span>
        )}
      </div>

      {useFutuData && <button type="button" onClick={() => setIntradayOpen(true)} className="shrink-0 rounded-md border border-gray-200 bg-white px-2 py-1 text-xs font-semibold text-gray-700 shadow-sm hover:bg-gray-100" aria-haspopup="dialog">15 minute</button>}

      {/* Real-time HSI cash price + live/stale status */}
      <div
        className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-[3px] text-xs font-semibold ${
          liveStale
            ? "border-amber-300 bg-amber-50 text-amber-700"
            : "border-emerald-300 bg-emerald-50 text-emerald-700"
        }`}
        title={liveStale ? "Real-time feed not updating — showing last value" : "Real-time HSI cash index"}
      >
        <span
          className={`inline-block h-2 w-2 rounded-full ${liveStale ? "bg-amber-500" : "bg-emerald-500 animate-pulse"}`}
        />
        {liveStale ? "STALE" : "LIVE"}
        {livePrice !== null && (
          <span className="tabular-nums text-[var(--text)]">
            {livePrice.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </span>
        )}
        {useFutuData && (
          <span
            className="border-l border-emerald-300 pl-1.5 tabular-nums text-[10px] font-bold text-emerald-600"
            title={`Next live price, warrant, volume, and open-interest refresh in ${liveRefreshCountdown} seconds`}
          >
            ↻ {liveRefreshCountdown}s
          </span>
        )}
      </div>
      {startupCheck && (
        <span
          title={startupCheck.title}
          className={`inline-flex items-center rounded-md border px-2 py-[3px] text-[10px] font-semibold uppercase tracking-normal ${
            startupCheck.status === "checking"
              ? "border-amber-300 bg-amber-50 text-amber-700"
              : startupCheck.status === "ok"
                ? "border-emerald-300 bg-emerald-50 text-emerald-700"
                : startupCheck.status === "warning"
                  ? "border-amber-300 bg-amber-50 text-amber-700"
                  : "border-red-300 bg-red-50 text-red-700"
          }`}
        >
          {startupCheck.label}
        </span>
      )}
    </>
  );

  const actionControls = (
    <>
      <button
        type="button"
        onClick={() => {
          if (refreshAllInFlightRef.current) return;
          refreshAllInFlightRef.current = true;
          forceFullRefreshRef.current = true;
          setManualRefreshActive(true);
          setManualRefreshVersion((version) => version + 1);
          window.dispatchEvent(new CustomEvent("market-data:refresh-all"));
        }}
        title="Reload the chart, live HSI, warrants, KO levels, money flow, and open interest now"
        className="inline-flex h-7 w-[166px] flex-none items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-blue-700 bg-blue-600 px-3 text-xs font-semibold text-white shadow-[0_2px_0_#1e3a8a] transition-all hover:bg-blue-700 active:translate-y-[2px] active:shadow-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:ring-offset-2"
      >
        <span className={manualRefreshActive ? "animate-spin" : ""}>↻</span>
        {manualRefreshActive ? "REFRESHING…" : "REFRESH ALL DATA"}
      </button>
      <button
        onClick={() => setAlertsMuted((m) => !m)}
        title={alertsMuted ? "Knockout alerts muted — click to unmute" : "Knockout alerts on — click to mute"}
        className={`inline-flex h-7 min-w-[88px] flex-none items-center justify-center gap-1 whitespace-nowrap rounded-md border px-2 text-xs font-semibold transition-colors ${
          alertsMuted
            ? "border-[var(--border)] text-gray-400 hover:text-gray-600"
            : "border-emerald-300 bg-emerald-50 text-emerald-700"
        }`}
      >
        {alertsMuted ? "🔕" : "🔔"} KO Alert
      </button>
      <button
        onClick={testKnockoutAlert}
        title="Fire a sample knockout alert (sound + visual)"
        className="inline-flex h-7 flex-none items-center justify-center gap-1 whitespace-nowrap rounded-md border border-[var(--border)] px-2 text-xs font-semibold text-[var(--muted)] transition-colors hover:bg-[rgba(0,0,0,0.04)] hover:text-[var(--text)]"
      >
        Test
      </button>
    </>
  );

  return (
    <div className="relative flex h-full flex-col">
      {intradayOpen && <HsiIntradayModal onClose={closeIntraday} levels={liveCbbcPayload?.cbbcLevels ?? []} cbbcStale={liveStale || Boolean(liveCbbcPayload?.stale) || liveCbbcPayload?.cbbcComplete !== true} />}
      {staleMessage && !isLoading && !hasError && (
        <div className="mb-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {staleMessage}
        </div>
      )}
      {useFutuData ? (
        <div className="mb-1.5 grid items-center gap-2 2xl:grid-cols-[minmax(560px,640px)_minmax(280px,440px)_minmax(330px,1fr)] 2xl:gap-4">
          <div className="flex min-w-0 items-center gap-3 2xl:h-[52px]">
            <h2 className="card-title shrink-0">HSI (Daily) · Futu verified</h2>
            <div className="flex flex-wrap items-center gap-2">{statusControls}</div>
          </div>
          <div className="w-full max-w-[520px] justify-self-center">
            <FuturesExpiryProgress />
          </div>
          <div className="flex min-w-max flex-nowrap items-center justify-end gap-2">{actionControls}</div>
        </div>
      ) : (
        <div className="mb-1.5 flex items-center gap-2">
          {statusControls}
          <div className="ml-auto flex items-center gap-2">{actionControls}</div>
        </div>
      )}
      <div
        ref={chartShotRef}
        className="relative flex-1 overflow-hidden rounded-lg border border-[var(--border)] bg-[rgba(0,0,0,0.02)] shadow-sm min-h-[420px]"
      >
        <div ref={containerRef} className="h-full w-full" />
        {useFutuData && (
          <>
            <div className="pointer-events-none absolute bottom-7 left-3 z-[3] text-[10px] font-semibold text-violet-600/70">
              Open interest · HKEX all-contract total
              {latestFutuOpenInterest && (
                <span className="ml-2 text-amber-600">
                  Live Futu main: {latestFutuOpenInterest.value.toLocaleString("en-US")} ({latestFutuOpenInterest.date})
                </span>
              )}
            </div>
            <div className="pointer-events-none absolute left-3 top-[53%] z-[3] text-[9px] font-semibold text-gray-600/60">
              Volume · contracts · 20D avg baseline
            </div>
          </>
        )}
        {screenshotCopied && (
          <div className="pointer-events-none absolute left-3 top-3 z-20 rounded-md border border-emerald-300 bg-emerald-50 px-2.5 py-1.5 text-xs font-semibold text-emerald-700 shadow-sm">
            Image copied
          </div>
        )}
        <div className="pointer-events-none absolute inset-0 z-[2]">
          {cbbcLineLabels.map((label) => (
            <div
              key={label.key}
              ref={(element) => {
                if (!element) {
                  cbbcLabelElementsRef.current.delete(label.key);
                  return;
                }
                cbbcLabelElementsRef.current.set(label.key, element);
                const current = cbbcLineLabelsRef.current.find((item) => item.key === label.key) ?? label;
                element.style.left = `${current.x}px`;
                element.style.top = `${current.y}px`;
                element.style.backgroundColor = current.color;
              }}
              data-cbbc-label="true"
              data-side={label.side}
              data-start={label.start}
              data-end={label.end}
              data-plot-level={label.level}
              data-trigger={label.trigger}
              data-knocked-out={label.knockedOut ? "true" : "false"}
              title={`${label.knockedOut ? "KNOCKED OUT · " : ""}${label.side} ${label.start.toLocaleString("en-US")}-${label.end.toLocaleString("en-US")} · line ${label.level.toLocaleString("en-US")} · trigger ${label.trigger.toLocaleString("en-US")}`}
              className="absolute -translate-y-1/2 rounded-[3px] px-1.5 py-[1px] text-[10px] font-semibold leading-[13px] text-white shadow-sm"
              style={{
                backgroundColor: label.color,
              }}
            >
              {label.knockedOut ? "KO · " : ""}{Math.round(label.volume).toLocaleString("en-US")}
            </div>
          ))}
        </div>
        {knockoutAlerts.length > 0 && (
          <div className="pointer-events-none absolute right-3 top-3 z-10 flex w-64 flex-col gap-2">
            {knockoutAlerts.map((a) => (
              <div
                key={a.id}
                className={`pointer-events-auto flex items-start gap-2 rounded-lg border px-3 py-2 shadow-lg backdrop-blur-sm ${
                  a.side === "bear"
                    ? "border-red-300 bg-red-50/95"
                    : "border-green-300 bg-green-50/95"
                }`}
                style={{ animation: "koFlash 0.6s ease-out" }}
              >
                <span className="text-base leading-none">⚠️</span>
                <div className="min-w-0 flex-1">
                  <div className={`text-xs font-bold ${a.side === "bear" ? "text-red-700" : "text-green-700"}`}>
                    {a.side === "bear" ? "Bear" : "Bull"} CBBC knocked out
                  </div>
                  <div className="text-[11px] text-[var(--text)]">
                    {a.start !== undefined && a.end !== undefined && a.end - a.start === 99
                      ? `${a.start.toLocaleString("en-US")}–${a.end.toLocaleString("en-US")}`
                      : `Strike ${a.price.toLocaleString("en-US")}`}
                    {" · "}{a.volume.toLocaleString("en-US")} contracts
                  </div>
                  <div className="text-[10px] text-[var(--muted)]">
                    {new Date(a.at).toLocaleTimeString()}
                  </div>
                </div>
                <button
                  onClick={() => setKnockoutAlerts((prev) => prev.filter((x) => x.id !== a.id))}
                  className="text-[var(--muted)] hover:text-[var(--text)]"
                  aria-label="Dismiss"
                >
                  ✕
                </button>
              </div>
            ))}
            <style>{`@keyframes koFlash {0%{transform:translateX(20px);opacity:0}100%{transform:translateX(0);opacity:1}}`}</style>
          </div>
        )}
      </div>
      <div className="mt-1 min-h-[28px] text-[10px] leading-[14px]">
        <div className="text-[var(--muted)]">
          好倉資金流 / 淡倉資金流 — Blue: inflow, Red: outflow (million)
        </div>
        <div className={moneyflowError ? "text-red-600" : "invisible"} aria-live="polite">
          {moneyflowError ?? "Money flow loaded"}
        </div>
      </div>
      {isLoading && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-[var(--muted)]">
          Loading HSI data…
        </div>
      )}
      {hasError && !isLoading && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-red-600">
          Failed to load HSI data
        </div>
      )}
    </div>
  );
}
