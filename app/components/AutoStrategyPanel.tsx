"use client";

import { useCallback, useEffect, useState } from "react";

type RrTrade = {
  outcome: "TP" | "SL" | "EOD" | "none";
  points: number;
  rMultiple: number;
  exitTime: string | null;
};

type DayRow = {
  date: string;
  orWidth: number | null;
  rangePoints: number;
  averageTrueRange: number | null;
  topTime: string | null;
  topLabel?: string | null;
  topSession?: "day" | "night" | null;
  bottomTime: string | null;
  bottomLabel?: string | null;
  bottomSession?: "day" | "night" | null;
  wrapTopTime?: string | null;
  wrapBottomTime?: string | null;
  wrapTopSession?: "day" | "night" | null;
  wrapBottomSession?: "day" | "night" | null;
  firstBreak: "long" | "short" | null;
  firstBreakTime: string | null;
  breakoutMfe: number | null;
  falseBreak: "long" | "short" | null;
  falseMfe: number | null;
  falseRr: RrTrade | null;
};

type GraphPayload = {
  volatility?: Array<{ date: string; rangePoints: number | null; orWidth: number | null }>;
  extremes?: Array<{
    date: string;
    topTime: string | null;
    topWrap?: number | null;
    topSession: "day" | "night" | null;
    bottomTime: string | null;
    bottomWrap?: number | null;
    bottomSession: "day" | "night" | null;
  }>;
  breakout?: Array<{ date: string; firstBreak: "long" | "short" | null; breakoutMfe: number | null; falseMfe: number | null }>;
  wrapExtremes?: Array<{
    date: string;
    topTime: string | null;
    topWrap?: number | null;
    topSession: "day" | "night" | null;
    bottomTime: string | null;
    bottomWrap?: number | null;
    bottomSession: "day" | "night" | null;
  }>;
};

type AutoResult = {
  ok?: boolean;
  error?: string;
  stale?: boolean;
  latest?: { timeKey?: string | null };
  coverage?: { count?: number; first?: string | null; last?: string | null; tradingDays?: number };
  days?: DayRow[];
  graphs?: GraphPayload;
  summary?: {
    lookbackDays: number;
    rewardRisk: number;
    dailyExtremes: { topWindow: { label: string }; bottomWindow: { label: string } };
    wrapExtremes?: { topWindow: { label: string }; bottomWindow: { label: string } };
    volatility: { averageRange: number | null; medianRange: number | null; minRange: number | null; maxRange: number | null };
    openingRangeBreakout: {
      days: number;
      longDays: number;
      shortDays: number;
      averageMfe: number | null;
    };
    falseBreakout: {
      days: number;
      averageMfe: number | null;
      rewardRisk: number;
      wins: number;
      losses: number;
      eod: number;
    };
  };
};

function formatPts(value: number | null | undefined, digits = 0) {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value.toFixed(digits)} pts`;
}

function shortDate(date: string) {
  return date.slice(5).replace("-", "/");
}

function formatPtsLabel(value: number) {
  return `${Math.round(value)}`;
}

function showSampledLabel(index: number, total: number, maximumLabels = 10) {
  const stride = Math.max(1, Math.ceil(total / maximumLabels));
  const distanceFromSample = index % stride;
  return distanceFromSample === 0 || (index === total - 1 && distanceFromSample >= Math.max(2, Math.floor(stride / 2)));
}

function emaValues(values: Array<number | null | undefined>, period: number) {
  const alpha = 2 / (Math.max(1, period) + 1);
  let previous: number | null = null;
  return values.map((value) => {
    if (value == null || !Number.isFinite(value)) return null;
    previous = previous == null ? value : value * alpha + previous * (1 - alpha);
    return previous;
  });
}

function lastFinite(values: Array<number | null>) {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (values[index] != null) return values[index];
  }
  return null;
}

function linePath(values: Array<number | null>, x: (index: number) => number, y: (value: number) => number) {
  let started = false;
  return values.reduce((path, value, index) => {
    if (value == null) return path;
    const command = started ? "L" : "M";
    started = true;
    return `${path}${command}${x(index).toFixed(2)} ${y(value).toFixed(2)} `;
  }, "");
}

function VolatilityChart({ rows }: { rows: NonNullable<GraphPayload["volatility"]> }) {
  const width = 900;
  const height = 280;
  const padding = { left: 56, right: 24, top: 20, bottom: 44 };
  const values = rows.map((row) => row.rangePoints).filter((value): value is number => value != null);
  const max = Math.max(1, ...values);
  const innerWidth = width - padding.left - padding.right;
  const innerHeight = height - padding.top - padding.bottom;
  const gap = innerWidth / Math.max(1, rows.length);
  const barWidth = Math.max(2, Math.min(48, gap * 0.72));
  const showValues = rows.length <= 16;
  const emaPeriod = Math.min(5, Math.max(1, rows.length));
  const ema = emaValues(rows.map((row) => row.rangePoints), emaPeriod);
  const latestEma = lastFinite(ema);
  const xForIndex = (index: number) => padding.left + index * gap + gap / 2;
  const yForValue = (value: number) => padding.top + innerHeight - (value / max) * innerHeight;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-60 w-full" role="img" aria-label="How many points each day moved">
      {rows.map((row, index) => {
        const value = row.rangePoints || 0;
        const x = padding.left + index * gap + (gap - barWidth) / 2;
        const barHeight = (value / max) * innerHeight;
        const y = padding.top + innerHeight - barHeight;
        return (
          <g key={row.date}>
            <title>{`${row.date}: ${formatPtsLabel(value)} points`}</title>
            <rect x={x} y={y} width={barWidth} height={Math.max(2, barHeight)} rx={Math.min(4, barWidth / 2)} fill="#2563eb" />
            {showValues && <text x={x + barWidth / 2} y={y - 8} textAnchor="middle" fontSize="13" fontWeight="700" fill="#171717">{formatPtsLabel(value)}</text>}
            {showSampledLabel(index, rows.length) && <text x={x + barWidth / 2} y={height - 16} textAnchor="middle" fontSize="13" fontWeight="600" fill="#404040">{shortDate(row.date)}</text>}
          </g>
        );
      })}
      {ema.length > 1 && <path d={linePath(ema, xForIndex, yForValue)} fill="none" stroke="#0f172a" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" />}
      {latestEma != null && <>
        <circle cx={xForIndex(ema.length - 1)} cy={yForValue(latestEma)} r="4" fill="#0f172a" />
        <text x={width - padding.right} y={Math.max(14, yForValue(latestEma) - 8)} textAnchor="end" fontSize="13" fontWeight="800" fill="#0f172a">EMA{emaPeriod} {formatPtsLabel(latestEma)} pts</text>
      </>}
      <text x={8} y={padding.top + 6} fontSize="13" fill="#525252">{Math.round(max)}</text>
    </svg>
  );
}

function utcDate(iso: string) {
  const [year, month, day] = iso.split("-").map(Number);
  if (!year || !month || !day) return null;
  return Date.UTC(year, month - 1, day);
}

function weekdayOfMonth(year: number, monthIndex: number, weekday: number, which: "last" | number) {
  if (which === "last") {
    const last = new Date(Date.UTC(year, monthIndex + 1, 0));
    const delta = (last.getUTCDay() - weekday + 7) % 7;
    return Date.UTC(year, monthIndex, last.getUTCDate() - delta);
  }
  const first = new Date(Date.UTC(year, monthIndex, 1));
  const delta = (weekday - first.getUTCDay() + 7) % 7;
  return Date.UTC(year, monthIndex, 1 + delta + (which - 1) * 7);
}

/** UK/EU civil summer time: after the last Sunday of March, before the last Sunday of October. */
function isEuropeSummer(iso: string) {
  const stamp = utcDate(iso);
  if (stamp == null) return false;
  const year = Number(iso.slice(0, 4));
  return stamp > weekdayOfMonth(year, 2, 0, "last") && stamp < weekdayOfMonth(year, 9, 0, "last");
}

/** US civil summer time: after the second Sunday of March, before the first Sunday of November. */
function isUsSummer(iso: string) {
  const stamp = utcDate(iso);
  if (stamp == null) return false;
  const year = Number(iso.slice(0, 4));
  return stamp > weekdayOfMonth(year, 2, 0, 2) && stamp < weekdayOfMonth(year, 10, 0, 1);
}

function wrapMinutesFromOpen(time: string | null | undefined) {
  if (!time) return null;
  const [hours, minutes] = time.split(":").map(Number);
  const value = hours * 60 + minutes;
  if (!Number.isFinite(value)) return null;
  const open = 9 * 60 + 15;
  const dayEnd = 16 * 60 + 30;
  const nightOpen = 17 * 60 + 15;
  const nightClose = 3 * 60;
  const daySpan = dayEnd - open;
  if (value >= open && value <= dayEnd) return value - open;
  if (value >= nightOpen) return daySpan + (value - nightOpen);
  if (value <= nightClose) return daySpan + (24 * 60 - nightOpen) + value;
  return null;
}

function HighLowTimeChart({ rows }: { rows: NonNullable<GraphPayload["extremes"]> }) {
  const width = 900;
  const padding = { left: 72, right: 28, top: 36, bottom: 44 };
  const height = 300;
  const dayStart = 9 * 60 + 15;
  const dayEnd = 16 * 60 + 30;
  const span = dayEnd - dayStart;
  const innerWidth = width - padding.left - padding.right;
  const innerHeight = height - padding.top - padding.bottom;
  const rowBand = innerHeight / Math.max(1, rows.length);
  const dotRadius = Math.max(2.2, Math.min(7, rowBand * 0.42));
  const xForClock = (time: string | null | undefined) => {
    if (!time) return null;
    const [hours, minutes] = time.split(":").map(Number);
    const value = hours * 60 + minutes;
    if (!Number.isFinite(value) || value < dayStart || value > dayEnd) return null;
    return padding.left + ((value - dayStart) / span) * innerWidth;
  };
  const ticks = ["09:15", "09:30", "10:30", "12:00", "13:00", "16:30"];
  const openRangeX = xForClock("09:30") ?? padding.left;
  const tenThirtyX = xForClock("10:30") ?? padding.left;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-64 w-full" role="img" aria-label="Compact map of day-session high and low times, with 9:30 and 10:30 lines">
      <rect x={padding.left} y={padding.top} width={innerWidth} height={innerHeight} fill="#fafafa" />
      <line x1={openRangeX} y1={padding.top} x2={openRangeX} y2={padding.top + innerHeight} stroke="#ea580c" strokeWidth="2" strokeDasharray="6 5" />
      <text x={openRangeX + 6} y={padding.top + 18} fontSize="14" fontWeight="800" fill="#ea580c">9:30</text>
      <line x1={tenThirtyX} y1={padding.top} x2={tenThirtyX} y2={padding.top + innerHeight} stroke="#0891b2" strokeWidth="2" strokeDasharray="6 5" />
      <text x={tenThirtyX + 6} y={padding.top + 18} fontSize="14" fontWeight="800" fill="#0891b2">10:30</text>
      {ticks.filter((tick) => tick !== "09:30" && tick !== "10:30").map((tick) => {
        const x = xForClock(tick);
        if (x == null) return null;
        return <line key={tick} x1={x} y1={padding.top} x2={x} y2={padding.top + innerHeight} stroke="#ececec" />;
      })}
      {rows.map((row, index) => {
        const y = padding.top + (index + 0.5) * (innerHeight / Math.max(1, rows.length));
        const highX = xForClock(row.topTime);
        const lowX = xForClock(row.bottomTime);
        const showLabel = showSampledLabel(index, rows.length, 12);
        return (
          <g key={row.date}>
            {showLabel && <text x={8} y={y + 4} fontSize="12" fontWeight="600" fill="#525252">{shortDate(row.date)}</text>}
            {showLabel && <line x1={padding.left} y1={y} x2={padding.left + innerWidth} y2={y} stroke="#e5e5e5" />}
            {highX != null && <circle cx={highX} cy={y} r={dotRadius} fill="#dc2626" stroke="#fff" strokeWidth="0.8"><title>{`${row.date} day high at ${row.topTime}`}</title></circle>}
            {lowX != null && <circle cx={lowX} cy={y} r={dotRadius} fill="#16a34a" stroke="#fff" strokeWidth="0.8"><title>{`${row.date} day low at ${row.bottomTime}`}</title></circle>}
          </g>
        );
      })}
      {ticks.filter((tick) => tick !== "09:30").map((tick) => {
        const x = xForClock(tick);
        if (x == null) return null;
        return (
          <text key={`label-${tick}`} x={x} y={height - 12} textAnchor={tick === "16:30" ? "end" : tick === "09:15" ? "start" : "middle"} fontSize="14" fontWeight={tick === "09:30" || tick === "10:30" ? 800 : 600} fill={tick === "09:30" ? "#ea580c" : tick === "10:30" ? "#0891b2" : "#525252"}>
            {tick === "09:30" ? "9:30" : tick}
          </text>
        );
      })}
    </svg>
  );
}

function WrapHighLowTimeChart({ rows }: { rows: NonNullable<GraphPayload["wrapExtremes"]> }) {
  const width = 1100;
  const padding = { left: 72, right: 28, top: 48, bottom: 44 };
  const height = 320;
  const daySpan = (16 * 60 + 30) - (9 * 60 + 15);
  const nightSpan = (24 * 60 - (17 * 60 + 15)) + (3 * 60);
  const innerWidth = width - padding.left - padding.right;
  const innerHeight = height - padding.top - padding.bottom;
  const dayWidth = innerWidth * 0.72;
  const nightWidth = innerWidth - dayWidth;
  const xForMinutes = (minutes: number | null) => {
    if (minutes == null || !Number.isFinite(minutes)) return null;
    if (minutes <= daySpan) return padding.left + (minutes / daySpan) * dayWidth;
    return padding.left + dayWidth + ((minutes - daySpan) / nightSpan) * nightWidth;
  };
  const xForClock = (time: string | null | undefined) => xForMinutes(wrapMinutesFromOpen(time));
  const dayEndX = xForMinutes(daySpan) ?? padding.left;
  const openRangeX = xForClock("09:30") ?? padding.left;
  const tenThirtyX = xForClock("10:30") ?? padding.left;
  const dayTicks = ["09:15", "09:30", "10:30", "12:00", "13:00", "16:30"];
  const rowCount = Math.max(1, rows.length);
  const band = innerHeight / rowCount;
  const dotRadius = Math.max(2.2, Math.min(7, band * 0.42));
  const guides = [
    {
      id: "close",
      color: "#404040",
      dash: undefined as string | undefined,
      name: "HK close",
      timeFor: () => "16:00",
    },
    {
      id: "eu",
      color: "#2563eb",
      dash: "5 4",
      name: "EU open",
      timeFor: (date: string) => (isEuropeSummer(date) ? "15:00" : "16:00"),
    },
    {
      id: "us",
      color: "#7c3aed",
      dash: "5 4",
      name: "US open",
      timeFor: (date: string) => (isUsSummer(date) ? "21:30" : "22:30"),
    },
  ];
  const guideSegments = guides.flatMap((guide) => {
    const groups: Array<{ time: string; start: number; end: number }> = [];
    rows.forEach((row, index) => {
      const time = guide.timeFor(row.date);
      const last = groups[groups.length - 1];
      if (last && last.time === time && last.end === index - 1) last.end = index;
      else groups.push({ time, start: index, end: index });
    });
    return groups.map((group) => ({ ...guide, ...group, x: xForClock(group.time) }));
  });
  const guideLabels = guideSegments.reduce<Array<{ key: string; x: number; color: string; text: string }>>((labels, segment) => {
    if (segment.x == null) return labels;
    const clock = segment.time.replace(/^0/, "");
    const sameSpot = labels.find((label) => Math.abs(label.x - segment.x) < 8);
    if (sameSpot) {
      sameSpot.text = `${sameSpot.text} · ${segment.name}`;
      return labels;
    }
    const key = `${segment.id}-${segment.time}`;
    if (labels.some((label) => label.key === key)) return labels;
    labels.push({ key, x: segment.x, color: segment.color, text: `${segment.name} ${clock}` });
    return labels;
  }, []);
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-64 w-full" role="img" aria-label="Compact wrap high and low map from 9:15 through night, with 9:30 and 10:30 lines, HK close, and Europe and US opens">
      <rect x={padding.left} y={padding.top} width={dayWidth} height={innerHeight} fill="#fafafa" />
      <rect x={dayEndX} y={padding.top} width={nightWidth} height={innerHeight} fill="#f4f4f5" />
      <text x={padding.left + dayWidth / 2} y={padding.top - 26} textAnchor="middle" fontSize="14" fontWeight="700" fill="#525252">Day 09:15–16:30</text>
      <text x={dayEndX + nightWidth / 2} y={padding.top - 26} textAnchor="middle" fontSize="14" fontWeight="700" fill="#525252">Night to 03:00</text>
      <line x1={openRangeX} y1={padding.top} x2={openRangeX} y2={padding.top + innerHeight} stroke="#ea580c" strokeWidth="2" strokeDasharray="6 5" />
      <text x={openRangeX + 8} y={padding.top + 18} fontSize="14" fontWeight="800" fill="#ea580c">9:30</text>
      <line x1={tenThirtyX} y1={padding.top} x2={tenThirtyX} y2={padding.top + innerHeight} stroke="#0891b2" strokeWidth="2" strokeDasharray="6 5" />
      <text x={tenThirtyX + 8} y={padding.top + 18} fontSize="14" fontWeight="800" fill="#0891b2">10:30</text>
      {guideSegments.map((segment) => {
        if (segment.x == null) return null;
        const y1 = padding.top + segment.start * band;
        const y2 = padding.top + (segment.end + 1) * band;
        return (
          <line
            key={`${segment.id}-${segment.time}-${segment.start}`}
            x1={segment.x}
            y1={y1}
            x2={segment.x}
            y2={y2}
            stroke={segment.color}
            strokeWidth="1.75"
            strokeDasharray={segment.dash}
          >
            <title>{`${segment.name} ${segment.time} HKT`}</title>
          </line>
        );
      })}
      {dayTicks.filter((tick) => tick !== "09:30" && tick !== "10:30").map((tick) => {
        const x = xForClock(tick);
        if (x == null) return null;
        return <line key={tick} x1={x} y1={padding.top} x2={x} y2={padding.top + innerHeight} stroke="#ececec" />;
      })}
      {rows.map((row, index) => {
        const y = padding.top + (index + 0.5) * (innerHeight / Math.max(1, rows.length));
        const highX = xForClock(row.topTime);
        const lowX = xForClock(row.bottomTime);
        const showLabel = showSampledLabel(index, rows.length, 12);
        return (
          <g key={row.date}>
            {showLabel && <text x={8} y={y + 4} fontSize="12" fontWeight="600" fill="#525252">{shortDate(row.date)}</text>}
            {showLabel && <line x1={padding.left} y1={y} x2={padding.left + innerWidth} y2={y} stroke="#e5e5e5" />}
            {highX != null && <circle cx={highX} cy={y} r={dotRadius} fill="#dc2626" stroke="#fff" strokeWidth="0.8"><title>{`${row.date} wrap high at ${row.topTime}`}</title></circle>}
            {lowX != null && <circle cx={lowX} cy={y} r={dotRadius} fill="#16a34a" stroke="#fff" strokeWidth="0.8"><title>{`${row.date} wrap low at ${row.bottomTime}`}</title></circle>}
          </g>
        );
      })}
      {dayTicks.filter((tick) => tick !== "09:30").map((tick) => {
        const x = xForClock(tick);
        if (x == null) return null;
        return (
          <text key={`label-${tick}`} x={x} y={height - 12} textAnchor={tick === "09:15" ? "start" : "middle"} fontSize="14" fontWeight={tick === "10:30" ? 800 : 600} fill={tick === "10:30" ? "#0891b2" : "#525252"}>
            {tick === "09:15" ? "9:15" : tick}
          </text>
        );
      })}
      <text x={padding.left + innerWidth} y={height - 12} textAnchor="end" fontSize="14" fontWeight="600" fill="#525252">03:00</text>
      {guideLabels.map((label) => (
        <text key={label.key} x={label.x} y={padding.top - 8} textAnchor="middle" fontSize="13" fontWeight="700" fill={label.color}>
          {label.text}
        </text>
      ))}
    </svg>
  );
}

function BreakMaxChart({ rows }: { rows: NonNullable<GraphPayload["breakout"]> }) {
  const width = 980;
  const height = 320;
  const padding = { left: 56, right: 24, top: 24, bottom: 48 };
  const values = rows.flatMap((row) => [row.breakoutMfe, row.falseMfe]).filter((value): value is number => value != null && value > 0);
  const max = Math.max(1, ...values);
  const innerWidth = width - padding.left - padding.right;
  const innerHeight = height - padding.top - padding.bottom;
  const group = innerWidth / Math.max(1, rows.length);
  const barWidth = Math.max(2, Math.min(22, group * 0.34));
  const showValues = rows.length <= 16;
  const emaPeriod = Math.min(5, Math.max(1, rows.length));
  const firstEma = emaValues(rows.map((row) => row.breakoutMfe), emaPeriod);
  const falseEma = emaValues(rows.map((row) => row.falseMfe), emaPeriod);
  const latestFirstEma = lastFinite(firstEma);
  const latestFalseEma = lastFinite(falseEma);
  const xForIndex = (index: number) => padding.left + index * group + group / 2;
  const yForValue = (value: number) => padding.top + innerHeight - (value / max) * innerHeight;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-60 w-full" role="img" aria-label="Max points after opening-range first break and false break">
      {rows.map((row, index) => {
        const cx = padding.left + index * group + group / 2;
        const first = Math.max(0, row.breakoutMfe ?? 0);
        const fake = Math.max(0, row.falseMfe ?? 0);
        const firstHeight = (first / max) * innerHeight;
        const fakeHeight = (fake / max) * innerHeight;
        const firstX = cx - barWidth - 3;
        const fakeX = cx + 3;
        return (
          <g key={row.date}>
            <title>{`${row.date}: first break ${formatPtsLabel(first)} points, false break ${formatPtsLabel(fake)} points`}</title>
            <rect x={firstX} y={padding.top + innerHeight - firstHeight} width={barWidth} height={Math.max(first ? 3 : 0, firstHeight)} rx="3" fill="#2563eb" />
            {showValues && first > 0 && <text x={firstX + barWidth / 2} y={padding.top + innerHeight - firstHeight - 8} textAnchor="middle" fontSize="13" fontWeight="700" fill="#1d4ed8">{formatPtsLabel(first)}</text>}
            <rect x={fakeX} y={padding.top + innerHeight - fakeHeight} width={barWidth} height={Math.max(fake ? 3 : 0, fakeHeight)} rx="3" fill="#c026d3" />
            {showValues && fake > 0 && <text x={fakeX + barWidth / 2} y={padding.top + innerHeight - fakeHeight - 8} textAnchor="middle" fontSize="13" fontWeight="700" fill="#a21caf">{formatPtsLabel(fake)}</text>}
            {showSampledLabel(index, rows.length) && <text x={cx} y={height - 16} textAnchor="middle" fontSize="13" fontWeight="600" fill="#404040">{shortDate(row.date)}</text>}
          </g>
        );
      })}
      {firstEma.length > 1 && <path d={linePath(firstEma, xForIndex, yForValue)} fill="none" stroke="#1e3a8a" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" />}
      {falseEma.length > 1 && <path d={linePath(falseEma, xForIndex, yForValue)} fill="none" stroke="#86198f" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" />}
      {latestFirstEma != null && <text x={width - padding.right} y={16} textAnchor="end" fontSize="13" fontWeight="800" fill="#1e3a8a">First EMA{emaPeriod}: {formatPtsLabel(latestFirstEma)} pts</text>}
      {latestFalseEma != null && <text x={width - padding.right} y={34} textAnchor="end" fontSize="13" fontWeight="800" fill="#86198f">False EMA{emaPeriod}: {formatPtsLabel(latestFalseEma)} pts</text>}
    </svg>
  );
}

export default function AutoStrategyPanel() {
  const [daysInput, setDaysInput] = useState("10");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AutoResult | null>(null);
  const parsedDays = Number(daysInput);
  const days = Number.isInteger(parsedDays) && parsedDays >= 1 && parsedDays <= 120 ? parsedDays : null;

  const run = useCallback(async (force = false) => {
    if (days == null) {
      setError("Enter a whole number from 1 to 120 trading dates.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/backtest/auto?days=${days}${force ? "&refresh=1" : ""}`, { cache: "no-store" });
      const payload = await response.json() as AutoResult;
      if (!response.ok || !payload.ok) throw new Error(payload.error || "Auto backtest failed.");
      setResult(payload);
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : "Auto backtest failed.");
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    if (days == null) return;
    const timer = window.setTimeout(() => void run(false), 350);
    return () => window.clearTimeout(timer);
  }, [days, run]);

  const summary = result?.summary;
  const rows = result?.days ?? [];
  const lookback = summary?.lookbackDays ?? days ?? "—";

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto pb-6">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 rounded-lg border border-neutral-200 bg-white px-4 py-3">
        <div>
          <h1 className="text-xl font-semibold tracking-[-0.02em]">Auto backtest</h1>
          <p className="mt-1 max-w-3xl text-base leading-6 text-neutral-600">
            Last {lookback} finished HSI futures days. Opening range is the first 15 minutes, 9:15–9:29. Charts use stored HK.HSImain 1-minute candles.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-sm font-semibold text-neutral-600">
            <span>Days</span>
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={120}
              step={1}
              value={daysInput}
              onChange={(event) => setDaysInput(event.target.value)}
              aria-describedby="auto-days-help"
              className="h-9 w-20 rounded-md border border-neutral-300 bg-white px-2 text-center text-sm font-semibold text-neutral-900"
            />
            <span id="auto-days-help" className="sr-only">Enter 1 to 120 completed trading dates</span>
          </label>
          <button
            type="button"
            onClick={() => void run(true)}
            disabled={loading || days == null}
            className="h-9 rounded-md bg-black px-4 text-sm font-semibold text-white disabled:opacity-40"
          >
            {loading ? "Calculating…" : "Recalculate"}
          </button>
          <span className={`h-9 rounded-md border px-3 py-2 text-xs font-semibold ${result?.stale ? "border-amber-200 bg-amber-50 text-amber-800" : "border-emerald-200 bg-emerald-50 text-emerald-800"}`}>
            {result?.stale ? `Delayed · ${result.latest?.timeKey || "unknown"}` : `Ready · ${result?.latest?.timeKey || result?.coverage?.last || "—"}`}
          </span>
          <span className="h-9 rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-xs font-semibold text-sky-800">
            SQLite · {Number(result?.coverage?.tradingDays ?? 0).toLocaleString("en-US")} sessions · {Number(result?.coverage?.count ?? 0).toLocaleString("en-US")} bars
          </span>
        </div>
      </div>

      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-base text-red-700">{error}</div>}

      <div className="grid min-w-0 shrink-0 gap-4 xl:grid-cols-2">
        <article className="min-w-0 overflow-hidden rounded-lg border border-neutral-200 bg-white p-4">
          <h2 className="text-lg font-bold">Opening-range follow-through</h2>
          <p className="mt-1 text-sm leading-5 text-neutral-600">
            <span className="font-semibold text-blue-700">Blue</span> = first 9:15–9:29 break. <span className="font-semibold text-fuchsia-700">Purple</span> = the opposite break after a false start. Dark lines are the rolling EMA of up to 5 shown sessions; the latest EMA points are labeled.
          </p>
          <BreakMaxChart rows={result?.graphs?.breakout ?? []} />
          <div className="mt-1 grid gap-1 text-sm md:grid-cols-2">
            <p><span className="font-semibold">First break:</span> {formatPts(summary?.openingRangeBreakout.averageMfe, 0)} avg · {summary?.openingRangeBreakout.longDays ?? 0} up / {summary?.openingRangeBreakout.shortDays ?? 0} down</p>
            <p><span className="font-semibold">False break:</span> {formatPts(summary?.falseBreakout.averageMfe, 0)} avg · {summary?.falseBreakout.days ?? 0} reversals · {summary?.falseBreakout.wins ?? 0}W / {summary?.falseBreakout.losses ?? 0}L / {summary?.falseBreakout.eod ?? 0} open</p>
          </div>
        </article>

        <article className="min-w-0 overflow-hidden rounded-lg border border-neutral-200 bg-white p-4">
          <h2 className="text-lg font-bold">How wild each day was</h2>
          <p className="mt-1 text-sm leading-5 text-neutral-600">
            Day high minus low, 9:15am–4:30pm. Night not included. The dark line is the rolling EMA of up to 5 shown sessions, labeled with its latest point value.
          </p>
          <VolatilityChart rows={result?.graphs?.volatility ?? []} />
          <p className="mt-2 text-sm"><span className="font-semibold">Average:</span> {formatPts(summary?.volatility.averageRange, 0)} · typically {formatPts(summary?.volatility.medianRange, 0)}</p>
        </article>
      </div>

      <div className="grid min-w-0 shrink-0 gap-4 xl:grid-cols-2">
        <article className="min-w-0 overflow-hidden rounded-lg border border-neutral-200 bg-white p-4">
          <h2 className="text-lg font-bold">High and low · day only</h2>
          <p className="mt-1 text-sm leading-5 text-neutral-600">
            9:15am–4:30pm · orange 9:30 · <span className="font-semibold text-cyan-700">teal 10:30</span> · <span className="font-semibold text-red-700">red high</span> · <span className="font-semibold text-green-700">green low</span>. Dense views sample date labels; hover dots for exact dates.
          </p>
          <HighLowTimeChart rows={result?.graphs?.extremes ?? []} />
          <p className="mt-2 text-sm"><span className="font-semibold">Highs</span> {summary?.dailyExtremes.topWindow.label || "—"} · <span className="font-semibold">lows</span> {summary?.dailyExtremes.bottomWindow.label || "—"}</p>
        </article>

        <article className="min-w-0 overflow-hidden rounded-lg border border-neutral-200 bg-white p-4">
          <h2 className="text-lg font-bold">High and low · including night</h2>
          <p className="mt-1 text-sm leading-5 text-neutral-600">
            Day then night to 3:00am · <span className="font-semibold text-red-700">red high</span> · <span className="font-semibold text-green-700">green low</span> · grey HK close · <span className="font-semibold text-blue-700">blue Europe open</span> · <span className="font-semibold text-violet-700">purple US open</span>.
          </p>
          <WrapHighLowTimeChart rows={result?.graphs?.wrapExtremes ?? []} />
          <p className="mt-2 text-sm"><span className="font-semibold">Wrap highs</span> {summary?.wrapExtremes?.topWindow.label || "—"} · <span className="font-semibold">wrap lows</span> {summary?.wrapExtremes?.bottomWindow.label || "—"}</p>
        </article>
      </div>

      <details className="overflow-hidden rounded-lg border border-neutral-200 bg-white">
        <summary className="flex cursor-pointer items-center justify-between px-5 py-3 text-base font-bold hover:bg-neutral-50">
          <span>Day-by-day details</span>
          <span className="text-sm font-medium text-neutral-500">{rows.length} dates · click to expand</span>
        </summary>
        <div className="overflow-auto">
          <table className="w-full min-w-[920px] border-collapse text-base">
            <thead className="sticky top-0 bg-neutral-50 text-sm text-neutral-600">
              <tr>
                {["Date", "Day high", "Day low", "Wrap high", "Wrap low", "Day move", "OR width", "First break", "First-break max", "False break", "False-break max"].map((label) => (
                  <th key={label} className="whitespace-nowrap px-4 py-3 text-left font-semibold">{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.slice().reverse().map((row) => (
                <tr key={row.date} className="border-t border-neutral-100">
                  <td className="px-4 py-3 font-semibold">{row.date}</td>
                  <td className="px-4 py-3 tabular-nums">{row.topTime || "—"}</td>
                  <td className="px-4 py-3 tabular-nums">{row.bottomTime || "—"}</td>
                  <td className="px-4 py-3 tabular-nums">{row.wrapTopTime || "—"}{row.wrapTopSession === "night" ? " n" : ""}</td>
                  <td className="px-4 py-3 tabular-nums">{row.wrapBottomTime || "—"}{row.wrapBottomSession === "night" ? " n" : ""}</td>
                  <td className="px-4 py-3 tabular-nums">{formatPts(row.rangePoints)}</td>
                  <td className="px-4 py-3 tabular-nums">{formatPts(row.orWidth)}</td>
                  <td className="px-4 py-3">{row.firstBreak === "long" ? "Up" : row.firstBreak === "short" ? "Down" : "—"}{row.firstBreakTime ? ` ${row.firstBreakTime}` : ""}</td>
                  <td className="px-4 py-3 tabular-nums">{formatPts(row.breakoutMfe)}</td>
                  <td className="px-4 py-3">{row.falseBreak === "long" ? "Up" : row.falseBreak === "short" ? "Down" : "—"}</td>
                  <td className="px-4 py-3 tabular-nums">{formatPts(row.falseMfe)}</td>
                </tr>
              ))}
              {!rows.length && (
                <tr>
                  <td colSpan={11} className="px-4 py-10 text-center text-neutral-500">
                    {loading ? "Running on stored 1-minute candles…" : "No finished opening-range days in this lookback."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
