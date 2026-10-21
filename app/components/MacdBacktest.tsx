"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  LineStyle,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";

type Candle = {
  time: number;
  timeKey: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

type ChunkPayload = { ok?: boolean; bars?: Candle[]; error?: string; hint?: string; cached?: boolean; stored?: boolean; stale?: boolean; latest?: { timeKey?: string | null }; coverage?: { first?: string | null; last?: string | null } };
type Direction = "long" | "short";
type ExitReason = "TP" | "SL" | "TRAILING_STOP" | "SIGNAL" | "REVERSE" | "END";
type Trade = {
  id: number;
  direction: Direction;
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  stopPrice: number;
  targetPrice: number;
  reason: ExitReason;
  pnl: number;
  pnlPerContract?: number;
  pnlHkd?: number;
  contracts?: number;
  riskAmount?: number;
  equityAfter?: number;
  barsHeld: number;
};
type TradeShape = Trade & { x1: number; x2: number; y1: number; y2: number };
type Timeframe = "1m" | "15m" | "4h" | "1d";
type PythonBacktestConfig = {
  timeframe: Timeframe;
  sessions: number;
  startingCapitalUsd: number;
  spreadPoints: number;
  riskPercent: number;
  executionMode: string;
  ambiguityPolicy: string;
};

const TIMEFRAMES: Array<{ value: Timeframe; label: string; days: number; chunks: number }> = [
  { value: "1m", label: "1m", days: 40, chunks: 42 },
  { value: "15m", label: "15m", days: 180, chunks: 42 },
  { value: "4h", label: "4h", days: 365, chunks: 30 },
  { value: "1d", label: "1d", days: 365, chunks: 30 },
];
const EARLIEST_DATE = "2000-01-01";
const DEFAULT_LOOKBACK_SESSIONS = 15;
const DEFAULT_CAPITAL_USD = 50_000;
const FALLBACK_USD_HKD = 7.8;

function pythonStringSetting(code: string, key: string, fallback: string) {
  const match = code.match(new RegExp(`["']${key}["']\\s*:\\s*["']([^"']+)["']`));
  return match?.[1] || fallback;
}

function pythonNumberSetting(code: string, key: string, fallback: number) {
  const match = code.match(new RegExp(`["']${key}["']\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`));
  const value = Number(match?.[1]);
  return Number.isFinite(value) ? value : fallback;
}

function pythonBacktestConfig(code: string): PythonBacktestConfig {
  const timeframeValue = pythonStringSetting(code, "timeframe", "1m");
  const timeframe = (["1m", "15m", "4h", "1d"] as string[]).includes(timeframeValue) ? timeframeValue as Timeframe : "1m";
  return {
    timeframe,
    sessions: Math.min(250, Math.max(1, Math.round(pythonNumberSetting(code, "sessions", DEFAULT_LOOKBACK_SESSIONS)))),
    startingCapitalUsd: Math.max(1, pythonNumberSetting(code, "starting_capital_usd", DEFAULT_CAPITAL_USD)),
    spreadPoints: Math.max(0, pythonNumberSetting(code, "spread_points", 6)),
    riskPercent: Math.min(100, Math.max(0.01, pythonNumberSetting(code, "risk_percent", 1))),
    executionMode: pythonStringSetting(code, "execution_mode", "intrabar_ohlc"),
    ambiguityPolicy: pythonStringSetting(code, "ambiguity_policy", "nearest"),
  };
}

function hktDate(value = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Hong_Kong", year: "numeric", month: "2-digit", day: "2-digit" }).format(value);
}

function shiftIsoDate(iso: string, days: number) {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function lastClosedHkSessionDate(today = hktDate()) {
  let date = shiftIsoDate(today, -1);
  let weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  while (weekday === 0 || weekday === 6) {
    date = shiftIsoDate(date, -1);
    weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  }
  return date;
}

function isDaySessionClock(clock: string) {
  return (clock >= "09:16" && clock <= "12:00") || (clock >= "13:01" && clock <= "16:30");
}

function nextWeekday(date: string) {
  let next = shiftIsoDate(date, 1);
  while ([0, 6].includes(new Date(`${next}T00:00:00Z`).getUTCDay())) next = shiftIsoDate(next, 1);
  return next;
}

function futuresSessionDate(bar: Candle) {
  const date = bar.timeKey.slice(0, 10);
  const value = bar.timeKey.slice(11, 16);
  if (value >= "17:15") return nextWeekday(date);
  if (value <= "03:00" || value < "09:16") {
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    return weekday === 0 || weekday === 6 ? nextWeekday(date) : date;
  }
  return date;
}

function sessionWindow(bars: Candle[], sessions: number) {
  const closed = lastClosedHkSessionDate();
  const dates = [...new Set(bars.filter((bar) => isDaySessionClock(bar.timeKey.slice(11, 16)) && bar.timeKey.slice(0, 10) <= closed).map((bar) => bar.timeKey.slice(0, 10)))].sort();
  const selected = dates.slice(-Math.min(250, Math.max(1, sessions)));
  return { start: selected[0] || "", end: selected.at(-1) || "", count: selected.length, dates: selected };
}

const DEFAULT_CODE = `# All backtest configuration lives here. Ask AI to edit this block and the strategy together.
BACKTEST = {
    "timeframe": "1m",                 # 1m, 15m, 4h or 1d
    "sessions": 15,                    # completed HSI futures sessions
    "starting_capital_usd": 50000,
    "spread_points": 6,
    "slippage_points": 0,
    "commission_hkd": 0,
    "risk_percent": 1,
    "point_value": 50,
    "margin_per_contract": 0,
    "execution_mode": "intrabar_ohlc", # next_bar_open, current_bar_close, intrabar_ohlc
    "ambiguity_policy": "nearest",     # worst_case, best_case, open_high_low_close, open_low_high_close, nearest
}

# Opening-range breakout expressed only as order intent.
def strategy(bars):
    orders = []
    current_day = None
    range_high = None
    range_low = None
    steps = [bars[i]["time"] - bars[i - 1]["time"] for i in range(1, min(len(bars), 500)) if bars[i]["time"] > bars[i - 1]["time"]]
    smallest_step = min(steps) if steps else 0
    range_start = "09:16" if smallest_step <= 60 else "09:30"
    range_end = "09:30"

    for i in range(len(bars)):
        day = bars[i]["timeKey"][:10]
        clock = bars[i]["timeKey"][11:16]
        if day != current_day:
            current_day = day
            range_high = None
            range_low = None

        if range_start <= clock <= range_end:
            range_high = bars[i]["high"] if range_high is None else max(range_high, bars[i]["high"])
            range_low = bars[i]["low"] if range_low is None else min(range_low, bars[i]["low"])

        # Submit both stop-entry orders after the opening range is complete.
        if clock == range_end and range_high is not None and range_low is not None:
            group = "ORB-" + day
            orders.append({
                "id": group + "-long", "bar_index": i, "side": "buy", "type": "stop",
                "price": range_high, "stop_loss": range_low, "reward_risk": 2.0,
                "expiry": "DAY", "oco_group": group, "comment": "Opening-range high breakout",
            })
            orders.append({
                "id": group + "-short", "bar_index": i, "side": "sell", "type": "stop",
                "price": range_low, "stop_loss": range_high, "reward_risk": 2.0,
                "expiry": "DAY", "oco_group": group, "comment": "Opening-range low breakout",
            })

    return {"orders": orders}`;

const AI_STRATEGY_PROMPT = `You are writing paste-ready Python strategy code for my order-driven HSI futures backtest engine.

SYSTEM CONTEXT
- Instrument: HK.HSImain, Hang Seng Index futures.
- All configuration is written inside the Python code. There are no separate configuration controls.
- The required top-level BACKTEST dictionary chooses timeframe, completed sessions, capital, costs, risk, execution and same-bar policy.
- Available BACKTEST timeframes: 1m, 15m, 4h and 1d.
- The panel calls strategy(bars) once with candles sorted oldest to newest.
- Each bar is a dictionary containing time, timeKey, open, high, low, close and volume.
- time is a Unix timestamp. timeKey is Hong Kong time formatted YYYY-MM-DD HH:MM:SS.
- Futu intraday timeKey represents the candle END time. For example, the 15m candle ending 09:30 represents approximately 09:15-09:29.
- If the user does not specify a setting, keep the defaults shown in the configuration template below.

WHAT THE ENGINE ALREADY INCLUDES
- Market, stop-entry and limit-entry orders.
- Long, short and automatic reversal when an opposite order fills.
- Initial stop loss, fixed take profit and reward-to-risk targets.
- ATR trailing exits with optional delayed activation.
- DAY and GTC pending-order expiry.
- Multiple orders and OCO cancellation using oco_group.
- Same-candle entry followed immediately by SL, TP or trailing-exit evaluation.
- Code-configurable execution modes: next_bar_open, current_bar_close and intrabar_ohlc.
- Code-configurable ambiguous OHLC policies: worst_case, best_case, open_high_low_close, open_low_high_close and nearest.
- starting_capital_usd is converted at the live USD/HKD quote for engine accounting. The engine owns HSI point value, costs, margin, risk-based sizing, fills, P&L and statistics according to BACKTEST.
- The strategy must not recreate any of those engine responsibilities.

REQUIRED PYTHON CONTRACT
1. Define one top-level literal dictionary named BACKTEST using the exact configuration keys shown below.
2. Define exactly one entry function named strategy(bars).
3. Return a dictionary containing "orders": return {"orders": orders}.
4. The strategy describes order intent only. Never manually simulate whether an order filled, whether SL/TP was hit, current position, contracts, P&L, equity or statistics.
5. Every order needs a unique id, bar_index, side and type.
6. bar_index=i means the order is submitted AFTER bars[i] is complete. The order may only use bars[0:i+1]. Never use bars[i+1] or later data to construct it.
7. Use side "buy" for long entry and "sell" for short entry.
8. Use type "market", "stop" or "limit".
9. A stop or limit order requires price. A market order does not require price.
10. Always provide a valid protective stop_loss unless the strategy request explicitly says otherwise. It must be below the expected long entry or above the expected short entry.
11. Omit quantity so the engine sizes the position from current equity, BACKTEST risk_percent and stop distance. Do not calculate contracts in strategy code.

REQUIRED BACKTEST CONFIGURATION TEMPLATE
BACKTEST = {
    "timeframe": "1m",
    "sessions": 15,
    "starting_capital_usd": 50000,
    "spread_points": 6,
    "slippage_points": 0,
    "commission_hkd": 0,
    "risk_percent": 1,
    "point_value": 50,
    "margin_per_contract": 0,
    "execution_mode": "intrabar_ohlc",
    "ambiguity_policy": "nearest",
}

CONFIGURATION RULES
- timeframe must be "1m", "15m", "4h" or "1d".
- sessions is the number of completed HSI futures sessions to load, from 1 to 250.
- starting_capital_usd must be positive. The runner converts it to HKD using the supplied live USD/HKD runtime rate.
- spread_points, slippage_points, commission_hkd and margin_per_contract must be zero or greater.
- risk_percent must be greater than 0 and at most 100.
- point_value is HKD per HSI point per contract; normally keep 50.
- execution_mode and ambiguity_policy must use one of the supported values above.
- Put every configuration choice in BACKTEST. Do not ask the user to set anything in the UI.

ORDER FIELDS
- id: required unique string.
- bar_index: required integer submission index.
- side: required "buy" or "sell".
- type: required "market", "stop" or "limit".
- price: required number for stop/limit; omit for market.
- stop_loss: initial protective-stop price and risk-sizing reference.
- take_profit: optional exact target price.
- reward_risk: optional target multiple such as 2.0. Use this instead of take_profit when the target should be based on the actual fill-to-stop distance.
- trailing_stop: optional ATR trailing configuration described below.
- expiry: optional "DAY" or "GTC"; default is DAY.
- oco_group: optional shared string. When one order fills, its unfilled peers in the same group are cancelled.
- comment: optional short description shown with the trade.
- quantity: supported but normally omit it because engine risk sizing is preferred.

ORDER TRIGGER RULES
- Buy stop: triggers when candle High >= price.
- Sell stop: triggers when candle Low <= price.
- Buy limit: triggers when candle Low <= price.
- Sell limit: triggers when candle High >= price.
- DAY expires when the HKT date changes. GTC remains pending.
- After an intrabar entry, SL/TP/trailing protection becomes active immediately in that candle.
- Do not code these trigger checks yourself after submitting an order.

EXIT CHOICES
Fixed exact target:
    "stop_loss": 24000,
    "take_profit": 24400

Risk/reward target calculated from actual fill:
    "stop_loss": 24000,
    "reward_risk": 2.0

Pure ATR trailing take-profit: keep initial stop_loss, omit take_profit and reward_risk, then add:
    "trailing_stop": {
        "type": "atr",
        "period": 14,
        "multiple": 2.0,
        "activate_after_r": 1.0
    }

ATR fields:
- period: ATR lookback candles.
- multiple: distance from the best price in ATR units.
- activate_after_r: activate after profit reaches this multiple of initial entry risk. Use 0 for immediate activation.
- Long trails the highest favorable price; short trails the lowest favorable price.
- The engine updates and triggers the trailing level. Strategy code must not calculate trailing levels after entry.

MINIMAL CORRECT MARKET-ORDER TEMPLATE
BACKTEST = {
    "timeframe": "1m", "sessions": 15, "starting_capital_usd": 50000,
    "spread_points": 6, "slippage_points": 0, "commission_hkd": 0,
    "risk_percent": 1, "point_value": 50, "margin_per_contract": 0,
    "execution_mode": "intrabar_ohlc", "ambiguity_policy": "nearest",
}

def strategy(bars):
    orders = []
    for i in range(20, len(bars)):
        previous_high = max(bars[j]["high"] for j in range(i - 20, i))
        if bars[i]["close"] > previous_high:
            orders.append({
                "id": "long-" + str(i),
                "bar_index": i,
                "side": "buy",
                "type": "market",
                "stop_loss": bars[i]["low"],
                "reward_risk": 2.0,
                "expiry": "DAY",
                "comment": "20-bar close breakout"
            })
    return {"orders": orders}

STOP-ENTRY EXAMPLE
orders.append({
    "id": "breakout-long-" + str(i),
    "bar_index": i,
    "side": "buy",
    "type": "stop",
    "price": breakout_high,
    "stop_loss": range_low,
    "reward_risk": 2.0,
    "expiry": "DAY"
})

LIMIT-ENTRY EXAMPLE
orders.append({
    "id": "pullback-long-" + str(i),
    "bar_index": i,
    "side": "buy",
    "type": "limit",
    "price": pullback_price,
    "stop_loss": invalidation_price,
    "take_profit": target_price,
    "expiry": "GTC"
})

OCO BREAKOUT EXAMPLE
group = "ORB-" + day
orders.append({"id": group + "-long", "bar_index": i, "side": "buy", "type": "stop", "price": range_high, "stop_loss": range_low, "reward_risk": 2.0, "expiry": "DAY", "oco_group": group})
orders.append({"id": group + "-short", "bar_index": i, "side": "sell", "type": "stop", "price": range_low, "stop_loss": range_high, "reward_risk": 2.0, "expiry": "DAY", "oco_group": group})

FULL WORKING OPENING-RANGE EXAMPLE
${DEFAULT_CODE}

PYTHON SANDBOX RESTRICTIONS
- No import statements.
- No files, network, OS access, input, eval, exec, globals or other system access.
- No pandas, NumPy or external packages.
- math is already available without importing.
- Available built-ins include abs, all, any, bool, dict, enumerate, float, int, len, list, max, min, range, round, sorted, str, sum, tuple and zip.
- Keep all returned values JSON-compatible: dictionaries, lists, strings, numbers, booleans and None.

LOOK-AHEAD RULES
- At index i, only read bars at indices <= i.
- Rolling windows ending at i must use ranges such as range(i - period, i) for prior completed candles or range(i - period + 1, i + 1) when the current completed candle is intentionally included.
- Do not use future highs/lows to decide earlier orders.
- Do not assume a pending order filled and do not suppress future signals based on a position you simulated yourself.

FINAL VALIDATION CHECKLIST
- strategy(bars) exists and always returns {"orders": orders}.
- BACKTEST exists and includes timeframe, sessions, capital, costs, risk, execution and ambiguity policy.
- Every id is unique.
- Every bar_index is an integer from 0 to len(bars)-1.
- Every stop/limit order has price.
- Every order has a logically valid stop_loss.
- No manual contracts, fills, positions, P&L, equity or statistics.
- No imports or unsupported built-ins.
- No look-ahead bias.
- For mutually exclusive long/short pending orders, use one shared oco_group.
- For ATR trailing-only exits, omit fixed take_profit.

OUTPUT RULE
After I describe a strategy, return ONLY one complete Python code block ready to paste into the panel. The code block must include the complete BACKTEST dictionary and strategy(bars). Do not include explanations outside the code. Use the order-driven contract, not legacy signals.

My strategy request:
`;

function maxStreak(trades: Trade[], winner: boolean) {
  let current = 0;
  let best = 0;
  trades.forEach((trade) => {
    if ((trade.pnl > 0) === winner) { current += 1; best = Math.max(best, current); }
    else current = 0;
  });
  return best;
}

function metricsFor(trades: Trade[], barCount: number, initialCapital: number) {
  const wins = trades.filter((trade) => trade.pnl > 0);
  const losses = trades.filter((trade) => trade.pnl <= 0);
  const grossProfit = wins.reduce((sum, trade) => sum + trade.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + trade.pnl, 0));
  const net = trades.reduce((sum, trade) => sum + trade.pnl, 0);
  let equity = initialCapital;
  let peak = initialCapital;
  let maxDrawdown = 0;
  trades.forEach((trade) => {
    equity += trade.pnl * 50;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  });

  const daily = new Map<string, number>();
  trades.forEach((trade) => {
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Hong_Kong", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(trade.exitTime * 1000));
    daily.set(day, (daily.get(day) ?? 0) + trade.pnl);
  });
  const dailyValues = [...daily.values()];
  const mean = dailyValues.length ? dailyValues.reduce((a, b) => a + b, 0) / dailyValues.length : 0;
  const variance = dailyValues.length > 1 ? dailyValues.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (dailyValues.length - 1) : 0;
  const sharpe = variance > 0 ? (mean / Math.sqrt(variance)) * Math.sqrt(252) : 0;
  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length ? wins.length / trades.length * 100 : 0,
    net,
    hkd: net * 50,
    initialCapital,
    endingEquity: initialCapital + net * 50,
    returnPercent: initialCapital > 0 ? net * 50 / initialCapital * 100 : 0,
    sharpe,
    profitFactor: grossLoss ? grossProfit / grossLoss : 0,
    maxDrawdown,
    averageTrade: trades.length ? net / trades.length : 0,
    averageWin: wins.length ? grossProfit / wins.length : 0,
    averageLoss: losses.length ? -grossLoss / losses.length : 0,
    payoff: losses.length && wins.length ? (grossProfit / wins.length) / (grossLoss / losses.length) : 0,
    longTrades: trades.filter((trade) => trade.direction === "long").length,
    shortTrades: trades.filter((trade) => trade.direction === "short").length,
    tp: trades.filter((trade) => trade.reason === "TP").length,
    sl: trades.filter((trade) => trade.reason === "SL").length,
    trailing: trades.filter((trade) => trade.reason === "TRAILING_STOP").length,
    signalExit: trades.filter((trade) => trade.reason === "SIGNAL").length,
    exposure: barCount ? trades.reduce((sum, trade) => sum + trade.barsHeld, 0) / barCount * 100 : 0,
    winStreak: maxStreak(trades, true),
    lossStreak: maxStreak(trades, false),
    averageContracts: trades.length ? trades.reduce((sum, trade) => sum + (trade.contracts ?? 1), 0) / trades.length : 0,
    maxContracts: trades.length ? Math.max(...trades.map((trade) => trade.contracts ?? 1)) : 0,
  };
}

function formatNumber(value: number, digits = 2) {
  return Number.isFinite(value) ? value.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits }) : "—";
}

function BacktestChart({ bars, trades, selectedTrade, timeframe }: { bars: Candle[]; trades: Trade[]; selectedTrade: Trade | null; timeframe: Timeframe }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const tradesRef = useRef(trades);
  const [shapes, setShapes] = useState<TradeShape[]>([]);
  const initializedRef = useRef(false);

  const updateShapes = useCallback(() => {
    const chart = chartRef.current;
    const series = candleRef.current;
    const width = hostRef.current?.clientWidth ?? 0;
    if (!chart || !series || width <= 0) return;
    const next = tradesRef.current.map((trade): TradeShape | null => {
      const x1 = chart.timeScale().timeToCoordinate(trade.entryTime as UTCTimestamp);
      const x2 = chart.timeScale().timeToCoordinate(trade.exitTime as UTCTimestamp);
      const y1 = series.priceToCoordinate(trade.entryPrice);
      const y2 = series.priceToCoordinate(trade.exitPrice);
      if ([x1, x2, y1, y2].some((value) => value === null || !Number.isFinite(value))) return null;
      if (Math.max(x1!, x2!) < -20 || Math.min(x1!, x2!) > width + 20) return null;
      return { ...trade, x1: Number(x1), x2: Number(x2), y1: Number(y1), y2: Number(y2) };
    }).filter((shape): shape is TradeShape => shape !== null).slice(-180);
    setShapes(next);
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let chart: IChartApi | null = null;
    let candle: ISeriesApi<"Candlestick"> | null = null;
    let observer: ResizeObserver | null = null;
    const start = () => {
      if (chart || host.clientWidth < 8 || host.clientHeight < 8) return;
      chart = createChart(host, {
        width: host.clientWidth,
        height: host.clientHeight,
        layout: { background: { type: ColorType.Solid, color: "#ffffff" }, textColor: "#737373", fontSize: 10, attributionLogo: false },
        grid: { vertLines: { visible: false }, horzLines: { visible: false } },
        crosshair: { mode: CrosshairMode.Normal, vertLine: { color: "#a3a3a3", style: LineStyle.Dashed }, horzLine: { color: "#a3a3a3", style: LineStyle.Dashed } },
        rightPriceScale: { borderColor: "#e5e7eb", scaleMargins: { top: 0.08, bottom: 0.08 } },
        timeScale: { borderColor: "#e5e7eb", timeVisible: true, secondsVisible: false, rightOffset: 5, barSpacing: 5 },
        localization: { timeFormatter: (time) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Hong_Kong", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(Number(time) * 1000)) },
        handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: true },
        handleScale: { axisPressedMouseMove: { time: true, price: true }, axisDoubleClickReset: { time: true, price: true }, mouseWheel: true, pinch: true },
      });
      candle = chart.addSeries(CandlestickSeries, {
        upColor: "#16a34a", downColor: "#dc2626", borderUpColor: "#16a34a", borderDownColor: "#dc2626", wickUpColor: "#15803d", wickDownColor: "#b91c1c", priceLineVisible: false,
      });
      chartRef.current = chart;
      candleRef.current = candle;
      chart.timeScale().subscribeVisibleLogicalRangeChange(updateShapes);
    };
    observer = new ResizeObserver(([entry]) => {
      start();
      if (!chart) return;
      chart.applyOptions({ width: entry.contentRect.width, height: entry.contentRect.height });
      requestAnimationFrame(updateShapes);
    });
    observer.observe(host);
    start();
    return () => {
      observer?.disconnect();
      chart?.timeScale().unsubscribeVisibleLogicalRangeChange(updateShapes);
      chart?.remove();
      chartRef.current = null;
      candleRef.current = null;
      initializedRef.current = false;
    };
  }, [updateShapes]);

  useEffect(() => {
    const chart = chartRef.current;
    const candle = candleRef.current;
    if (!chart || !candle || !bars.length) return;
    const visible = chart.timeScale().getVisibleRange();
    candle.setData(bars.map((bar) => ({ time: bar.time as UTCTimestamp, open: bar.open, high: bar.high, low: bar.low, close: bar.close })));
    if (!initializedRef.current) {
      chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, bars.length - 320), to: bars.length + 5 });
      initializedRef.current = true;
    } else if (visible) chart.timeScale().setVisibleRange(visible);
    requestAnimationFrame(updateShapes);
  }, [bars, updateShapes]);

  useEffect(() => {
    tradesRef.current = trades;
    requestAnimationFrame(updateShapes);
  }, [trades, updateShapes]);

  useEffect(() => {
    if (!selectedTrade || !chartRef.current) return;
    const entry = bars.findIndex((bar) => bar.time === selectedTrade.entryTime);
    const exit = bars.findIndex((bar) => bar.time === selectedTrade.exitTime);
    if (entry < 0) return;
    chartRef.current.timeScale().setVisibleLogicalRange({ from: Math.max(0, entry - 55), to: Math.min(bars.length + 5, Math.max(entry + 55, exit + 25)) });
    requestAnimationFrame(updateShapes);
  }, [selectedTrade, bars, updateShapes]);

  return (
    <div className="relative h-full min-h-0 overflow-hidden rounded-lg border border-neutral-200 bg-white">
      <div ref={hostRef} className="absolute inset-0" />
      <div className="pointer-events-none absolute left-3 top-2 z-20 rounded bg-white/85 px-2 py-1 text-[10px] font-semibold text-neutral-500 backdrop-blur-sm">
        HK.HSImain · {timeframe}
      </div>
      <svg className="pointer-events-none absolute inset-0 z-10 h-full w-full overflow-hidden">
        {shapes.map((shape) => {
          const profitable = shape.pnl > 0;
          const entryColor = shape.direction === "long" ? "#16a34a" : "#dc2626";
          const hasRoomForLabels = Math.abs(shape.x2 - shape.x1) >= 18;
          return (
            <g key={shape.id}>
              <line x1={shape.x1} y1={shape.y1} x2={shape.x2} y2={shape.y2} stroke={profitable ? "#16a34a" : "#dc2626"} strokeWidth={selectedTrade?.id === shape.id ? "2.5" : "1.25"} strokeDasharray="4 3" opacity={selectedTrade?.id === shape.id ? "1" : "0.72"} />
              <path
                d={shape.direction === "long"
                  ? `M${shape.x1} ${shape.y1 - 5}L${shape.x1 - 4.5} ${shape.y1 + 4}L${shape.x1 + 4.5} ${shape.y1 + 4}Z`
                  : `M${shape.x1} ${shape.y1 + 5}L${shape.x1 - 4.5} ${shape.y1 - 4}L${shape.x1 + 4.5} ${shape.y1 - 4}Z`}
                fill={entryColor}
                stroke="#fff"
                strokeWidth="1.2"
              />
              {hasRoomForLabels && <text x={shape.x1 + 6} y={shape.y1 - 5} fill={entryColor} fontSize="8" fontWeight="700">{shape.direction === "long" ? "BUY" : "SELL"}</text>}
              <rect x={shape.x2 - 3} y={shape.y2 - 3} width="6" height="6" rx="1" fill={profitable ? "#16a34a" : "#dc2626"} stroke="#fff" strokeWidth="1.1" />
              {hasRoomForLabels && <text x={shape.x2 + 5} y={shape.y2 + 11} fill={profitable ? "#15803d" : "#b91c1c"} fontSize="8" fontWeight="700">{shape.reason}</text>}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function EquityCurve({ trades, initialCapitalUsd, fxRate, selectedTradeId, onSelect }: { trades: Trade[]; initialCapitalUsd: number; fxRate: number; selectedTradeId: number | null; onSelect: (trade: Trade) => void }) {
  const width = 1000;
  const height = 130;
  const padding = { left: 16, right: 70, top: 16, bottom: 16 };
  const rate = fxRate > 0 ? fxRate : FALLBACK_USD_HKD;
  const toUsd = (hkd: number) => hkd / rate;
  const values = [initialCapitalUsd];
  trades.forEach((trade) => values.push(values.at(-1)! + toUsd(trade.pnlHkd ?? trade.pnl * 50)));
  const low = Math.min(...values);
  const high = Math.max(...values);
  const spread = Math.max(1, high - low);
  const floor = low - spread * 0.08;
  const ceiling = high + spread * 0.08;
  const x = (index: number) => padding.left + index / Math.max(1, values.length - 1) * (width - padding.left - padding.right);
  const y = (value: number) => padding.top + (ceiling - value) / Math.max(1, ceiling - floor) * (height - padding.top - padding.bottom);
  const points = values.map((value, index) => `${x(index)},${y(value)}`).join(" ");
  const selected = selectedTradeId === null ? null : trades.find((trade) => trade.id === selectedTradeId) ?? null;
  const selectedIndex = selected ? trades.findIndex((trade) => trade.id === selected.id) : -1;
  const selectedPnlUsd = selected ? toUsd(selected.pnlHkd ?? selected.pnl * 50) : 0;

  return (
    <div className="relative h-36 shrink-0 overflow-hidden rounded-lg border border-neutral-200 bg-white" aria-label="Clickable equity curve">
      <div className="pointer-events-none absolute left-3 top-2 z-10 text-[10px] font-bold uppercase tracking-[0.08em] text-violet-600">Equity curve · USD</div>
      {selected && <div className="pointer-events-none absolute right-3 top-2 z-10 rounded bg-neutral-900 px-2 py-1 text-[10px] font-semibold text-white">#{selected.id + 1} · {selected.direction === "long" ? "BUY" : "SELL"} · {selectedPnlUsd >= 0 ? "+" : ""}US${formatNumber(selectedPnlUsd, 0)}</div>}
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="absolute inset-0 h-full w-full cursor-crosshair" onClick={(event) => {
        if (!trades.length) return;
        const rect = event.currentTarget.getBoundingClientRect();
        const viewX = (event.clientX - rect.left) / Math.max(1, rect.width) * width;
        const ratio = Math.min(1, Math.max(0, (viewX - padding.left) / Math.max(1, width - padding.left - padding.right)));
        const index = Math.min(trades.length - 1, Math.max(0, Math.round(ratio * (trades.length - 1))));
        onSelect(trades[index]);
      }}>
        <defs>
          <linearGradient id="equityFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#8b5cf6" stopOpacity="0.20" />
            <stop offset="100%" stopColor="#8b5cf6" stopOpacity="0.015" />
          </linearGradient>
        </defs>
        <line x1={padding.left} y1={y(initialCapitalUsd)} x2={width - padding.right} y2={y(initialCapitalUsd)} stroke="#d4d4d4" strokeDasharray="4 4" />
        <polygon points={`${x(0)},${height - padding.bottom} ${points} ${x(values.length - 1)},${height - padding.bottom}`} fill="url(#equityFill)" />
        <polyline points={points} fill="none" stroke="#7c3aed" strokeWidth="2.2" vectorEffect="non-scaling-stroke" />
        {trades.map((trade, index) => {
          const markerX = x(index + 1);
          const markerY = y(values[index + 1]);
          const isSelected = trade.id === selectedTradeId;
          const color = trade.direction === "long" ? "#16a34a" : "#dc2626";
          return (
            <circle key={trade.id} cx={markerX} cy={markerY} r={isSelected ? 5.5 : 1.35} fill={isSelected ? "#fff" : color} stroke={isSelected ? color : "none"} strokeWidth={isSelected ? 2.5 : 0} opacity={isSelected ? 1 : 0.62} vectorEffect="non-scaling-stroke" />
          );
        })}
        {selected && selectedIndex >= 0 && <text x={x(selectedIndex + 1)} y={y(values[selectedIndex + 1]) + 2.5} textAnchor="middle" fontSize="7" fontWeight="800" fill={selected.direction === "long" ? "#16a34a" : "#dc2626"}>{selected.direction === "long" ? "B" : "S"}</text>}
        <text x={width - padding.right + 8} y={y(high) + 3} fontSize="10" fill="#737373">{`US$${formatNumber(high, 0)}`}</text>
        <text x={width - padding.right + 8} y={y(low) + 3} fontSize="10" fill="#737373">{`US$${formatNumber(low, 0)}`}</text>
      </svg>
    </div>
  );
}

export default function MacdBacktest() {
  const [bars, setBars] = useState<Candle[]>([]);
  const [loading, setLoading] = useState(true);
  const [historyComplete, setHistoryComplete] = useState(false);
  const [chunks, setChunks] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState(DEFAULT_CODE);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [strategyBars, setStrategyBars] = useState<Candle[] | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [phase, setPhase] = useState<"idle" | "calculating" | "replaying" | "ready">("idle");
  const [playbackIndex, setPlaybackIndex] = useState(-1);
  const [selectedTradeId, setSelectedTradeId] = useState<number | null>(null);
  const [promptCopied, setPromptCopied] = useState(false);
  const [usdHkd, setUsdHkd] = useState(FALLBACK_USD_HKD);
  const [runCapital, setRunCapital] = useState(DEFAULT_CAPITAL_USD * FALLBACK_USD_HKD);
  const [runFxRate, setRunFxRate] = useState(FALLBACK_USD_HKD);
  const [runBarCount, setRunBarCount] = useState(0);
  const [availableCoverage, setAvailableCoverage] = useState<{ first?: string | null; last?: string | null }>({});
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [refreshingHistory, setRefreshingHistory] = useState(false);
  const [historyStale, setHistoryStale] = useState(false);
  const [latestBarKey, setLatestBarKey] = useState<string | null>(null);
  const codeConfig = useMemo(() => pythonBacktestConfig(code), [code]);
  const timeframe = codeConfig.timeframe;

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    const config = TIMEFRAMES.find((item) => item.value === timeframe)!;
    setBars([]);
    setLoading(true);
    setRefreshingHistory(refreshNonce > 0);
    setHistoryComplete(false);
    setChunks(0);
    setError(null);
    setAvailableCoverage({});
    setHistoryStale(false);
    setLatestBarKey(null);
    setTrades([]);
    setStrategyBars(null);
    setPlaybackIndex(-1);
    setSelectedTradeId(null);
    setPhase("idle");
    const load = async () => {
      if (refreshNonce > 0) {
        try {
          const refreshResponse = await fetch("/api/backtest/refresh", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            cache: "no-store",
            signal: controller.signal,
            body: JSON.stringify({ timeframe, force: true }),
          });
          const refreshPayload = await refreshResponse.json() as { ok?: boolean; stale?: boolean; error?: string; results?: Array<{ latest?: { timeKey?: string | null }; coverage?: { first?: string | null; last?: string | null }; stale?: boolean; error?: string }> };
          const current = refreshPayload.results?.[0];
          if (current?.coverage) setAvailableCoverage(current.coverage);
          if (current?.latest?.timeKey) setLatestBarKey(current.latest.timeKey);
          setHistoryStale(Boolean(current?.stale || refreshPayload.stale));
          if (!refreshResponse.ok && !current?.latest?.timeKey) {
            throw new Error(current?.error ?? refreshPayload.error ?? "Could not refresh Futu history.");
          }
        } catch {
          if (controller.signal.aborted || cancelled) return;
          setHistoryStale(true);
        } finally {
          if (!cancelled) setRefreshingHistory(false);
        }
      }

      let end = lastClosedHkSessionDate();
      let merged: Candle[] = [];
      for (let batch = 0; batch < config.chunks && end > EARLIEST_DATE; batch += 1) {
        try {
          const response = await fetch(`/api/backtest/candles?end=${end}&days=${config.days}&timeframe=${timeframe}`, { signal: controller.signal, cache: "no-store" });
          const payload = (await response.json()) as ChunkPayload;
          if (!response.ok || !payload.ok) throw new Error(payload.error ?? payload.hint ?? "Could not load Futu history.");
          const next = Array.isArray(payload.bars) ? payload.bars : [];
          if (payload.coverage) setAvailableCoverage(payload.coverage);
          if (payload.latest?.timeKey) setLatestBarKey(payload.latest.timeKey);
          if (typeof payload.stale === "boolean") setHistoryStale(payload.stale);
          if (!next.length) { setHistoryComplete(true); break; }
          const byTime = new Map<number, Candle>();
          [...next, ...merged].forEach((bar) => byTime.set(bar.time, bar));
          merged = [...byTime.values()].sort((a, b) => a.time - b.time);
          if (!cancelled) {
            setBars(merged);
            setChunks(batch + 1);
            setLoading(false);
            setError(null);
          }
          const oldest = next[0]?.timeKey?.slice(0, 10);
          if (!oldest) { setHistoryComplete(true); break; }
          const previousDay = new Date(`${oldest}T00:00:00Z`);
          previousDay.setUTCDate(previousDay.getUTCDate() - 1);
          const nextEnd = previousDay.toISOString().slice(0, 10);
          if (nextEnd >= end || oldest <= EARLIEST_DATE) { setHistoryComplete(true); break; }
          end = nextEnd;
          // Futu history calls are quota-limited. Keep the first chunk fast, then
          // deliberately pace older chunks so background loading does not trip OpenD.
          await new Promise((resolve) => setTimeout(resolve, payload.stored ? 25 : 10_000));
        } catch (loadError) {
          if (controller.signal.aborted || cancelled) return;
          setError(loadError instanceof Error ? loadError.message : "Backtest data failed.");
          setLoading(false);
          break;
        }
      }
      if (!cancelled) setHistoryComplete(true);
    };
    load();
    return () => { cancelled = true; controller.abort(); };
  }, [timeframe, refreshNonce]);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/markets", { cache: "no-store", signal: controller.signal })
      .then((response) => response.json() as Promise<{ quotes?: Array<{ symbol?: string; price?: number | null }> }>)
      .then((payload) => {
        const price = payload.quotes?.find((quote) => quote.symbol === "USDHKD=X")?.price;
        if (typeof price === "number" && Number.isFinite(price) && price > 0) setUsdHkd(price);
      })
      .catch(() => { /* keep fallback USD/HKD */ });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (phase !== "replaying") return;
    if (playbackIndex >= trades.length - 1) {
      const done = window.setTimeout(() => setPhase("ready"), 450);
      return () => window.clearTimeout(done);
    }
    const stride = Math.max(1, Math.ceil(trades.length / 160));
    const next = window.setTimeout(() => setPlaybackIndex((index) => Math.min(trades.length - 1, index + stride)), 35);
    return () => window.clearTimeout(next);
  }, [phase, playbackIndex, trades.length]);

  const sessions = codeConfig.sessions;
  const lookback = useMemo(() => sessionWindow(bars, sessions), [bars, sessions]);

  const runStrategy = async () => {
    if (bars.length < 30 || phase === "calculating") return;
    const capital = codeConfig.startingCapitalUsd * usdHkd;
    if (lookback.count < 1) { setRunError("Need at least one completed session in stored history."); return; }
    const wanted = new Set(lookback.dates);
    const runBars = bars.filter((bar) => wanted.has(futuresSessionDate(bar)));
    setPhase("calculating");
    setRunError(null);
    setTrades([]);
    setRunCapital(capital);
    setRunFxRate(usdHkd);
    setStrategyBars(runBars.length >= 30 ? runBars : null);
    setRunBarCount(runBars.length);
    setPlaybackIndex(-1);
    setSelectedTradeId(null);
    try {
      const response = await fetch("/api/backtest/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code, usdHkd }) });
      const payload = await response.json() as { ok?: boolean; trades?: Trade[]; bars?: Candle[]; barCount?: number; error?: string };
      if (!response.ok || !payload.ok) throw new Error(payload.error ?? "Python strategy failed.");
      const nextTrades = payload.trades ?? [];
      setRunBarCount(payload.barCount ?? runBars.length);
      if (payload.bars?.length) setStrategyBars(payload.bars);
      setTrades(nextTrades);
      setSelectedTradeId(nextTrades[0]?.id ?? null);
      if (nextTrades.length) { setPlaybackIndex(0); setPhase("replaying"); }
      else setPhase("ready");
    } catch (runFailure) {
      setRunError(runFailure instanceof Error ? runFailure.message : "Python strategy failed.");
      setPhase("idle");
    }
  };

  const copyAiPrompt = async () => {
    const fallback = document.createElement("textarea");
    fallback.value = AI_STRATEGY_PROMPT;
    fallback.setAttribute("readonly", "");
    fallback.style.position = "fixed";
    fallback.style.opacity = "0";
    document.body.appendChild(fallback);
    fallback.select();
    let copied = document.execCommand("copy");
    fallback.remove();
    if (!copied && navigator.clipboard) {
      try {
        await Promise.race([
          navigator.clipboard.writeText(AI_STRATEGY_PROMPT),
          new Promise((_, reject) => window.setTimeout(() => reject(new Error("Clipboard timeout")), 800)),
        ]);
        copied = true;
      } catch { /* handled below */ }
    }
    if (copied) {
      setRunError(null);
      setPromptCopied(true);
      window.setTimeout(() => setPromptCopied(false), 1800);
    } else {
      setRunError("Could not copy the AI prompt. Please allow clipboard access and try again.");
    }
  };

  const visibleTrades = phase === "replaying" ? trades.slice(0, playbackIndex + 1) : trades;
  const rangedBars = useMemo(() => {
    if (!lookback.dates.length) return bars;
    const wanted = new Set(lookback.dates);
    return bars.filter((bar) => wanted.has(futuresSessionDate(bar)));
  }, [bars, lookback.dates]);
  const displayedBars = strategyBars ?? rangedBars;
  const replayTrade = phase === "replaying" ? trades[playbackIndex] ?? null : null;
  const selectedTrade = selectedTradeId === null ? null : trades.find((trade) => trade.id === selectedTradeId) ?? null;
  const focusedTrade = replayTrade ?? selectedTrade;
  const selectedTradeIndex = selectedTrade ? trades.findIndex((trade) => trade.id === selectedTrade.id) : -1;

  const focusTrade = async (trade: Trade) => {
    setSelectedTradeId(trade.id);
    if (phase === "replaying") setPhase("ready");
    if (displayedBars.some((bar) => bar.time === trade.entryTime)) return;
    const tradeDate = new Date(trade.entryTime * 1000);
    tradeDate.setUTCDate(tradeDate.getUTCDate() + 3);
    const end = tradeDate.toISOString().slice(0, 10);
    try {
      const response = await fetch(`/api/backtest/candles?end=${end}&days=7&timeframe=${timeframe}`, { cache: "no-store" });
      const payload = await response.json() as ChunkPayload;
      if (!response.ok || !payload.ok || !payload.bars?.length) throw new Error(payload.error ?? "Could not load the selected trade window.");
      setStrategyBars(payload.bars);
      setRunError(null);
    } catch (focusError) {
      setRunError(focusError instanceof Error ? focusError.message : "Could not locate the selected trade.");
    }
  };

  const biggestWin = trades.length ? trades.reduce((best, trade) => (trade.pnlHkd ?? trade.pnl * 50) > (best.pnlHkd ?? best.pnl * 50) ? trade : best) : null;
  const biggestLoss = trades.length ? trades.reduce((worst, trade) => (trade.pnlHkd ?? trade.pnl * 50) < (worst.pnlHkd ?? worst.pnl * 50) ? trade : worst) : null;
  const capitalUsd = codeConfig.startingCapitalUsd;
  const liveCapitalHkd = capitalUsd * usdHkd;
  const metricsCapital = phase === "idle" ? liveCapitalHkd : runCapital;
  const displayRate = (phase === "idle" ? usdHkd : runFxRate) || FALLBACK_USD_HKD;
  const toUsd = (hkd: number) => hkd / displayRate;
  const metrics = useMemo(() => metricsFor(visibleTrades, runBarCount || displayedBars.length, metricsCapital), [displayedBars.length, metricsCapital, runBarCount, visibleTrades]);
  const range = displayedBars.length ? `${displayedBars[0].timeKey.slice(0, 10)} → ${displayedBars.at(-1)!.timeKey.slice(0, 10)}` : "—";
  const rows = [
    ["Total trades", metrics.trades.toLocaleString()], ["Wins / losses", `${metrics.wins} / ${metrics.losses}`],
    ["Win rate", `${formatNumber(metrics.winRate)}%`], ["Starting capital", `US$${formatNumber(toUsd(metrics.initialCapital), 0)}`],
    ["Ending equity", `US$${formatNumber(toUsd(metrics.endingEquity), 0)}`], ["Total return", `${formatNumber(metrics.returnPercent)}%`],
    ["Net P&L", `${formatNumber(metrics.net)} pts`],
    ["Contract P&L", `US$${formatNumber(toUsd(metrics.hkd), 0)}`], ["Sharpe ratio", formatNumber(metrics.sharpe)],
    ["Profit factor", formatNumber(metrics.profitFactor)], ["Maximum drawdown", `US$${formatNumber(toUsd(metrics.maxDrawdown), 0)}`],
    ["Average trade", `${formatNumber(metrics.averageTrade)} pts`], ["Average win", `${formatNumber(metrics.averageWin)} pts`],
    ["Average loss", `${formatNumber(metrics.averageLoss)} pts`], ["Win / loss payoff", formatNumber(metrics.payoff)],
    ["Long / short", `${metrics.longTrades} / ${metrics.shortTrades}`], ["TP / SL / trail / signal", `${metrics.tp} / ${metrics.sl} / ${metrics.trailing} / ${metrics.signalExit}`],
    ["Market exposure", `${formatNumber(metrics.exposure)}%`], ["Max win streak", metrics.winStreak.toString()],
    ["Max loss streak", metrics.lossStreak.toString()], ["Avg position size", `${formatNumber(metrics.averageContracts, 3)} contracts`],
    ["Max position size", `${formatNumber(metrics.maxContracts, 3)} contracts`], [`${timeframe} bars`, (runBarCount || displayedBars.length).toLocaleString()],
  ];

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex shrink-0 items-center justify-between gap-4">
        <div>
          <h1 className="text-base font-semibold tracking-[-0.02em]">Python strategy backtest</h1>
          <p className="text-[11px] text-neutral-500">HK.HSImain · code config: {timeframe} · {sessions} sessions · US${formatNumber(codeConfig.startingCapitalUsd, 0)} · {formatNumber(codeConfig.riskPercent)}% risk · {range}</p>
        </div>
        <div className="flex items-center gap-2 text-[10px]">
          <span className={`rounded border px-2 py-1 font-semibold ${phase === "replaying" || phase === "calculating" ? "border-blue-200 bg-blue-50 text-blue-700" : phase === "ready" ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-neutral-200 bg-white text-neutral-600"}`}>
            {phase === "calculating" ? "Running Python…" : phase === "replaying" ? `Backtesting ${playbackIndex + 1} / ${trades.length}` : phase === "ready" ? `Complete · ${trades.length} trades` : "Ready to run"}
          </span>
          <span className={`rounded border px-2 py-1 ${historyStale ? "border-amber-200 bg-amber-50 text-amber-700" : historyComplete ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-amber-200 bg-amber-50 text-amber-700"}`}>
            {refreshingHistory
              ? "Refreshing Futu history…"
              : historyStale
                ? `Delayed · last ${latestBarKey || availableCoverage.last || "unknown"}`
                : historyComplete
                  ? `History ready · last ${latestBarKey || availableCoverage.last || "unknown"} · ${chunks} batches`
                  : `Lazy-loading history · ${chunks} batches`}
          </span>
          <button
            type="button"
            onClick={() => setRefreshNonce((value) => value + 1)}
            disabled={refreshingHistory || loading}
            className="rounded-md border border-neutral-300 bg-white px-3 py-1 font-semibold text-neutral-800 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {refreshingHistory ? "Refreshing…" : "Refresh data"}
          </button>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,64fr)_minmax(290px,36fr)] gap-3">
        <section className="flex min-h-0 flex-col gap-2">
          <div className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-neutral-200 bg-white px-2">
            <button type="button" disabled={!trades.length || selectedTradeIndex <= 0} onClick={() => { const trade = trades[Math.max(0, selectedTradeIndex - 1)]; if (trade) void focusTrade(trade); }} className="rounded-md border border-neutral-200 px-2.5 py-1 text-[11px] font-semibold disabled:opacity-35">← Last</button>
            <button type="button" disabled={!trades.length || selectedTradeIndex < 0 || selectedTradeIndex >= trades.length - 1} onClick={() => { const trade = trades[selectedTradeIndex + 1]; if (trade) void focusTrade(trade); }} className="rounded-md border border-neutral-200 px-2.5 py-1 text-[11px] font-semibold disabled:opacity-35">Next →</button>
            <button type="button" disabled={!biggestWin} onClick={() => { if (biggestWin) void focusTrade(biggestWin); }} className="rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold text-emerald-700 disabled:opacity-35">Biggest win</button>
            <button type="button" disabled={!biggestLoss} onClick={() => { if (biggestLoss) void focusTrade(biggestLoss); }} className="rounded-md border border-red-200 bg-red-50 px-2.5 py-1 text-[11px] font-semibold text-red-700 disabled:opacity-35">Biggest loss</button>
            <div className="ml-auto text-[10px] font-medium text-neutral-500">{selectedTrade ? `Trade ${selectedTradeIndex + 1} / ${trades.length}` : trades.length ? `${trades.length} trades` : "No trades"}</div>
          </div>
          <div className="relative min-h-0 flex-1">
            <BacktestChart bars={displayedBars} trades={visibleTrades} selectedTrade={focusedTrade} timeframe={timeframe} />
            {(loading || refreshingHistory) && <div className="absolute inset-0 flex items-center justify-center rounded-lg border border-neutral-200 bg-white text-sm text-neutral-500">{refreshingHistory ? `Refreshing ${timeframe} candles from Futu…` : `Loading recent ${timeframe} candles…`}</div>}
            {error && <div className="absolute inset-0 flex items-center justify-center rounded-lg border border-red-200 bg-red-50 p-6 text-center text-sm text-red-700">{error}</div>}
          </div>
          <EquityCurve trades={visibleTrades} initialCapitalUsd={toUsd(metricsCapital)} fxRate={displayRate} selectedTradeId={focusedTrade?.id ?? null} onSelect={(trade) => void focusTrade(trade)} />
        </section>

        <aside className="flex min-h-0 flex-col gap-3">
          <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-neutral-200 bg-white">
            <div className="flex items-center justify-between border-b border-neutral-200 px-4 py-2.5">
              <div><div className="text-sm font-bold">Python Code</div><div className="text-[10px] text-neutral-500">BACKTEST config + strategy(bars) are the complete machine</div></div>
              <div className="flex items-center gap-2">
                <button type="button" onClick={copyAiPrompt} className={`rounded-md border px-3 py-1.5 text-xs font-semibold transition-colors ${promptCopied ? "border-emerald-300 bg-emerald-50 text-emerald-700" : "border-neutral-300 bg-white text-neutral-700 hover:bg-neutral-50"}`}>{promptCopied ? "✓ Copied" : "Copy AI Prompt"}</button>
                {phase === "replaying" ? <button type="button" onClick={() => { setPlaybackIndex(trades.length - 1); setPhase("ready"); }} className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-xs font-semibold">Finish now</button> : <button type="button" onClick={runStrategy} disabled={phase === "calculating" || bars.length < 30} className="rounded-md bg-black px-4 py-1.5 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40">{phase === "calculating" ? "Running…" : "▶ Run"}</button>}
              </div>
            </div>
            {runError && <div className="border-b border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{runError}</div>}
            <textarea value={code} onChange={(event) => setCode(event.target.value)} spellCheck={false} className="min-h-0 flex-1 resize-none bg-neutral-950 p-3 font-mono text-[12px] leading-5 text-neutral-100 outline-none" aria-label="Python strategy code" />
          </section>
          <section className="flex min-h-0 flex-[1.05] flex-col overflow-hidden rounded-lg border border-neutral-200 bg-white">
          <div className="border-b border-neutral-200 px-4 py-3">
            <div className="text-lg font-bold tracking-[-0.02em]">Statistics</div>
            <div className="mt-0.5 text-xs text-neutral-500">Metrics update as each trade is replayed</div>
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            <table className="w-full table-fixed border-collapse text-sm">
              <tbody>
                {rows.map(([label, value]) => (
                  <tr key={label} className="border-b border-neutral-100 last:border-0">
                    <th className="w-[57%] px-4 py-2.5 text-left font-medium text-neutral-500">{label}</th>
                    <td className="w-[43%] whitespace-nowrap px-4 py-2.5 text-right font-bold tabular-nums text-neutral-900">{value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div></section>
        </aside>
      </div>
      <div className="shrink-0 text-[10px] text-neutral-500">
        Code-driven setup · BACKTEST chooses data and engine settings; strategy(bars) describes order intent. The runner blocks imports and unsafe system access.
      </div>
    </div>
  );
}
