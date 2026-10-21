/* eslint-disable @typescript-eslint/no-require-imports */
const OR_START = "09:16";
const OR_END = "09:30";
const DAY_START = "09:16";
const MORNING_END = "12:00";
const AFTERNOON_START = "13:01";
const SESSION_END = "16:30";
const NIGHT_START = "17:15";
const NIGHT_END = "03:00";

function clock(bar) {
  return String(bar.timeKey || "").slice(11, 16);
}

function dayKey(bar) {
  return String(bar.timeKey || "").slice(0, 10);
}

function clockMinutes(value) {
  const [hours, minutes] = String(value).split(":").map(Number);
  return hours * 60 + minutes;
}

function addCalendarDays(date, days) {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

function isWeekend(date) {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  return weekday === 0 || weekday === 6;
}

function nextWeekday(date) {
  let next = addCalendarDays(date, 1);
  while (isWeekend(next)) next = addCalendarDays(next, 1);
  return next;
}

function isOpeningRangeBar(bar) {
  const value = clock(bar);
  return value >= OR_START && value <= OR_END;
}

function isDaySessionBar(bar) {
  const value = clock(bar);
  return (value >= DAY_START && value <= MORNING_END) || (value >= AFTERNOON_START && value <= SESSION_END);
}

function isNightBar(bar) {
  const value = clock(bar);
  return value >= NIGHT_START || value <= NIGHT_END;
}

function sessionDate(bar) {
  const date = dayKey(bar);
  const value = clock(bar);
  if (value >= NIGHT_START) return nextWeekday(date);
  if (value <= NIGHT_END || value < DAY_START) return isWeekend(date) ? nextWeekday(date) : date;
  return date;
}

function wrapMinute(time) {
  const mins = clockMinutes(time);
  const nightOpen = clockMinutes(NIGHT_START);
  if (mins >= nightOpen) return mins - nightOpen;
  if (mins <= clockMinutes(NIGHT_END)) return (24 * 60 - nightOpen) + mins;
  return (24 * 60 - nightOpen + clockMinutes(NIGHT_END) + 1) + (mins - clockMinutes("09:15"));
}

function wrapToClock(wrap) {
  const nightOpen = clockMinutes(NIGHT_START);
  const overnightEnd = 24 * 60 - nightOpen + clockMinutes(NIGHT_END);
  if (wrap <= overnightEnd) {
    const mins = (nightOpen + Math.round(wrap)) % (24 * 60);
    const hours = Math.floor(mins / 60);
    const minutes = mins % 60;
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
  }
  const mins = clockMinutes("09:15") + Math.round(wrap - overnightEnd - 1);
  const hours = Math.floor(mins / 60);
  const minutes = ((mins % 60) + 60) % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function sessionTag(time) {
  const value = String(time);
  return value >= NIGHT_START || value <= NIGHT_END ? "night" : "day";
}

function formatTimeLabel(time) {
  if (!time) return "—";
  return `${time} ${sessionTag(time) === "night" ? "n" : "d"}`;
}

function mean(values) {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(sorted, fraction) {
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * fraction;
  const low = Math.floor(index);
  const high = Math.ceil(index);
  if (low === high) return sorted[low];
  return sorted[low] * (high - index) + sorted[high] * (index - low);
}

function minutesFromOpen(time) {
  return clockMinutes(time) - clockMinutes("09:15");
}

function formatClockFromOpen(minutesFromOpenValue) {
  const total = clockMinutes("09:15") + Math.round(minutesFromOpenValue);
  const hours = Math.floor(total / 60);
  const minutes = ((total % 60) + 60) % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function timeWindow(clocks) {
  const minutes = clocks
    .map(minutesFromOpen)
    .filter((value) => Number.isFinite(value) && value >= 0 && value <= 435)
    .sort((a, b) => a - b);
  if (!minutes.length) {
    return { count: 0, earliest: null, p25: null, median: null, p75: null, latest: null, label: "—" };
  }
  const earliest = formatClockFromOpen(minutes[0]);
  const latest = formatClockFromOpen(minutes[minutes.length - 1]);
  const p25 = formatClockFromOpen(percentile(minutes, 0.25));
  const median = formatClockFromOpen(percentile(minutes, 0.5));
  const p75 = formatClockFromOpen(percentile(minutes, 0.75));
  return {
    count: minutes.length,
    earliest,
    p25,
    median,
    p75,
    latest,
    label: `${p25}–${p75} (median ${median})`,
  };
}

function wrapTimeWindow(clocks) {
  const minutes = clocks.map(wrapMinute).filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!minutes.length) {
    return { count: 0, earliest: null, p25: null, median: null, p75: null, latest: null, label: "—" };
  }
  const toLabel = (value) => formatTimeLabel(wrapToClock(value));
  const earliest = toLabel(minutes[0]);
  const latest = toLabel(minutes[minutes.length - 1]);
  const p25 = toLabel(percentile(minutes, 0.25));
  const median = toLabel(percentile(minutes, 0.5));
  const p75 = toLabel(percentile(minutes, 0.75));
  return {
    count: minutes.length,
    earliest,
    p25,
    median,
    p75,
    latest,
    label: `${p25}–${p75} (median ${median})`,
  };
}

function firstBreakSide(bar, orHigh, orLow) {
  const hitHigh = bar.high >= orHigh;
  const hitLow = bar.low <= orLow;
  if (!hitHigh && !hitLow) return null;
  if (hitHigh && hitLow) {
    const distHigh = Math.abs(bar.open - orHigh);
    const distLow = Math.abs(bar.open - orLow);
    if (distHigh === distLow) return "ambiguous";
    return distHigh < distLow ? "long" : "short";
  }
  return hitHigh ? "long" : "short";
}

function groupDaySessions(bars) {
  const days = new Map();
  for (const bar of bars) {
    const key = sessionDate(bar);
    if (!days.has(key)) days.set(key, { date: key, bars: [], dayBars: [] });
    const session = days.get(key);
    session.bars.push(bar);
    if (isDaySessionBar(bar)) session.dayBars.push(bar);
  }
  return [...days.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((session) => ({
      ...session,
      bars: session.bars.sort((a, b) => a.time - b.time),
      dayBars: session.dayBars.sort((a, b) => a.time - b.time),
    }));
}

function extremeBar(bars, field, pick) {
  if (!bars.length) return null;
  const value = pick(...bars.map((bar) => bar[field]));
  return bars.find((bar) => bar[field] === value) || null;
}

function trueRangeAverage(bars) {
  if (!bars.length) return null;
  let trueRangeSum = 0;
  for (let index = 0; index < bars.length; index += 1) {
    const previous = index ? bars[index - 1].close : bars[0].open;
    trueRangeSum += Math.max(
      bars[index].high - bars[index].low,
      Math.abs(bars[index].high - previous),
      Math.abs(bars[index].low - previous),
    );
  }
  return trueRangeSum / bars.length;
}

function analyzeDay(session, rewardRisk) {
  const bars = session.dayBars?.length ? session.dayBars : session.bars.filter(isDaySessionBar);
  const allBars = session.bars;
  const orBars = bars.filter(isOpeningRangeBar);
  const orComplete = orBars.length >= 10;
  const orHigh = orComplete ? Math.max(...orBars.map((bar) => bar.high)) : null;
  const orLow = orComplete ? Math.min(...orBars.map((bar) => bar.low)) : null;
  const dayHigh = bars.length ? Math.max(...bars.map((bar) => bar.high)) : null;
  const dayLow = bars.length ? Math.min(...bars.map((bar) => bar.low)) : null;
  const allHigh = allBars.length ? Math.max(...allBars.map((bar) => bar.high)) : null;
  const allLow = allBars.length ? Math.min(...allBars.map((bar) => bar.low)) : null;
  const topBar = extremeBar(bars, "high", Math.max);
  const bottomBar = extremeBar(bars, "low", Math.min);
  const wrapTopBar = extremeBar(allBars, "high", Math.max);
  const wrapBottomBar = extremeBar(allBars, "low", Math.min);
  const trueRangeSum = trueRangeAverage(bars);

  const postOr = orComplete ? bars.filter((bar) => clock(bar) > OR_END) : [];
  let firstBreak = null;
  let firstBreakTime = null;
  let firstBreakIndex = -1;
  let breakoutMfe = null;
  let breakoutEod = null;
  let falseBreak = null;
  let falseMfe = null;
  let falseRr = null;

  if (orComplete && orHigh != null && orLow != null && orHigh > orLow) {
    for (let index = 0; index < postOr.length; index += 1) {
      const side = firstBreakSide(postOr[index], orHigh, orLow);
      if (!side || side === "ambiguous") continue;
      firstBreak = side;
      firstBreakTime = clock(postOr[index]);
      firstBreakIndex = index;
      break;
    }

    if (firstBreak) {
      const rest = postOr.slice(firstBreakIndex);
      if (firstBreak === "long") {
        breakoutMfe = Math.max(...rest.map((bar) => bar.high)) - orHigh;
        breakoutEod = rest.at(-1).close - orHigh;
      } else {
        breakoutMfe = orLow - Math.min(...rest.map((bar) => bar.low));
        breakoutEod = orLow - rest.at(-1).close;
      }

      const opposite = firstBreak === "long" ? "short" : "long";
      let oppositeIndex = -1;
      for (let index = firstBreakIndex; index < postOr.length; index += 1) {
        const bar = postOr[index];
        const hitOpposite = opposite === "long" ? bar.high >= orHigh : bar.low <= orLow;
        const hitFirstAgain = firstBreak === "long" ? bar.high >= orHigh : bar.low <= orLow;
        if (index === firstBreakIndex && hitFirstAgain && hitOpposite) {
          oppositeIndex = index;
          break;
        }
        if (index > firstBreakIndex && hitOpposite) {
          oppositeIndex = index;
          break;
        }
      }

      if (oppositeIndex >= 0) {
        const probe = postOr.slice(firstBreakIndex, oppositeIndex + 1);
        const probeHigh = Math.max(...probe.map((bar) => bar.high));
        const probeLow = Math.min(...probe.map((bar) => bar.low));
        const after = postOr.slice(oppositeIndex);
        falseBreak = opposite;
        if (opposite === "long") {
          falseMfe = Math.max(...after.map((bar) => bar.high)) - orHigh;
          const stop = Math.min(orLow, probeLow);
          const risk = orHigh - stop;
          const target = orHigh + rewardRisk * risk;
          falseRr = simulateRr(after, "long", orHigh, stop, target);
        } else {
          falseMfe = orLow - Math.min(...after.map((bar) => bar.low));
          const stop = Math.max(orHigh, probeHigh);
          const risk = stop - orLow;
          const target = orLow - rewardRisk * risk;
          falseRr = simulateRr(after, "short", orLow, stop, target);
        }
      }
    }
  }

  return {
    date: session.date,
    orComplete,
    orHigh,
    orLow,
    orWidth: orComplete ? orHigh - orLow : null,
    dayHigh,
    dayLow,
    rangePoints: dayHigh != null && dayLow != null ? dayHigh - dayLow : null,
    allRangePoints: allHigh != null && allLow != null ? allHigh - allLow : null,
    averageTrueRange: trueRangeSum,
    topTime: topBar ? clock(topBar) : null,
    topLabel: topBar ? formatTimeLabel(clock(topBar)) : null,
    topSession: topBar ? sessionTag(clock(topBar)) : null,
    topWrap: topBar ? wrapMinute(clock(topBar)) : null,
    bottomTime: bottomBar ? clock(bottomBar) : null,
    bottomLabel: bottomBar ? formatTimeLabel(clock(bottomBar)) : null,
    bottomSession: bottomBar ? sessionTag(clock(bottomBar)) : null,
    bottomWrap: bottomBar ? wrapMinute(clock(bottomBar)) : null,
    wrapTopTime: wrapTopBar ? clock(wrapTopBar) : null,
    wrapTopLabel: wrapTopBar ? formatTimeLabel(clock(wrapTopBar)) : null,
    wrapTopSession: wrapTopBar ? sessionTag(clock(wrapTopBar)) : null,
    wrapTopWrap: wrapTopBar ? wrapMinute(clock(wrapTopBar)) : null,
    wrapBottomTime: wrapBottomBar ? clock(wrapBottomBar) : null,
    wrapBottomLabel: wrapBottomBar ? formatTimeLabel(clock(wrapBottomBar)) : null,
    wrapBottomSession: wrapBottomBar ? sessionTag(clock(wrapBottomBar)) : null,
    wrapBottomWrap: wrapBottomBar ? wrapMinute(clock(wrapBottomBar)) : null,
    allHigh,
    allLow,
    firstBreak,
    firstBreakTime,
    breakoutMfe,
    breakoutEod,
    falseBreak,
    falseMfe,
    falseRr,
  };
}

function simulateRr(bars, side, entry, stop, target) {
  const risk = Math.abs(entry - stop);
  if (!(risk > 0) || !bars.length) {
    return { outcome: "none", points: 0, rMultiple: 0, exitTime: null };
  }
  for (const bar of bars) {
    const hitStop = side === "long" ? bar.low <= stop : bar.high >= stop;
    const hitTarget = side === "long" ? bar.high >= target : bar.low <= target;
    if (hitStop && hitTarget) {
      return { outcome: "SL", points: -risk, rMultiple: -1, exitTime: clock(bar) };
    }
    if (hitStop) {
      return { outcome: "SL", points: -risk, rMultiple: -1, exitTime: clock(bar) };
    }
    if (hitTarget) {
      return { outcome: "TP", points: rewardPoints(entry, target), rMultiple: Math.abs(target - entry) / risk, exitTime: clock(bar) };
    }
  }
  const last = bars.at(-1);
  const points = side === "long" ? last.close - entry : entry - last.close;
  return { outcome: "EOD", points, rMultiple: points / risk, exitTime: clock(last) };
}

function rewardPoints(entry, target) {
  return Math.abs(target - entry);
}

function summarize(days, rewardRisk) {
  const complete = days.filter((day) => day.orComplete);
  const tops = complete.map((day) => day.topTime).filter(Boolean);
  const bottoms = complete.map((day) => day.bottomTime).filter(Boolean);
  const ranges = complete.map((day) => day.rangePoints).filter((value) => Number.isFinite(value));
  const atrs = complete.map((day) => day.averageTrueRange).filter((value) => Number.isFinite(value));
  const orWidths = complete.map((day) => day.orWidth).filter((value) => Number.isFinite(value));
  const breakouts = complete.filter((day) => day.firstBreak);
  const longs = breakouts.filter((day) => day.firstBreak === "long");
  const shorts = breakouts.filter((day) => day.firstBreak === "short");
  const falseBreaks = complete.filter((day) => day.falseBreak);
  const rrTrades = falseBreaks.map((day) => day.falseRr).filter(Boolean);
  const wins = rrTrades.filter((trade) => trade.outcome === "TP");
  const losses = rrTrades.filter((trade) => trade.outcome === "SL");
  return {
    lookbackDays: complete.length,
    rewardRisk,
    openingRange: { start: "09:15", end: "09:29", definition: "Futu HK.HSImain 1m candles ending 09:16 through 09:30, covering 09:15–09:29 HKT." },
    session: "HSI day session 09:15–12:00 and 13:00–16:30 HKT. Night session is ignored for high/low timing and volatility.",
    dailyExtremes: {
      topWindow: timeWindow(tops),
      bottomWindow: timeWindow(bottoms),
      scope: "09:15–16:30 HKT only",
    },
    wrapExtremes: {
      topWindow: wrapTimeWindow(complete.map((day) => day.wrapTopTime).filter(Boolean)),
      bottomWindow: wrapTimeWindow(complete.map((day) => day.wrapBottomTime).filter(Boolean)),
      scope: "night 17:15–03:00 plus day 09:15–16:30",
    },
    volatility: {
      averageRange: mean(ranges),
      medianRange: percentile([...ranges].sort((a, b) => a - b), 0.5),
      minRange: ranges.length ? Math.min(...ranges) : null,
      maxRange: ranges.length ? Math.max(...ranges) : null,
      averageOneMinuteTr: mean(atrs),
      averageOpeningRangeWidth: mean(orWidths),
      scope: "09:15–12:00 and 13:00–16:30 HKT only",
    },
    openingRangeBreakout: {
      days: breakouts.length,
      longDays: longs.length,
      shortDays: shorts.length,
      averageMfe: mean(breakouts.map((day) => day.breakoutMfe).filter((value) => Number.isFinite(value))),
      averageEodFollowThrough: mean(breakouts.map((day) => day.breakoutEod).filter((value) => Number.isFinite(value))),
      averageLongMfe: mean(longs.map((day) => day.breakoutMfe).filter((value) => Number.isFinite(value))),
      averageShortMfe: mean(shorts.map((day) => day.breakoutMfe).filter((value) => Number.isFinite(value))),
    },
    falseBreakout: {
      days: falseBreaks.length,
      averageMfe: mean(falseBreaks.map((day) => day.falseMfe).filter((value) => Number.isFinite(value))),
      rewardRisk,
      trades: rrTrades.length,
      wins: wins.length,
      losses: losses.length,
      eod: rrTrades.filter((trade) => trade.outcome === "EOD").length,
      winRate: rrTrades.length ? (wins.length / rrTrades.length) * 100 : null,
      averageRrPoints: mean(rrTrades.map((trade) => trade.points)),
      expectancyR: mean(rrTrades.map((trade) => trade.rMultiple)),
    },
  };
}

function buildGraphs(days) {
  const complete = days.filter((day) => day.orComplete);
  const overnightEnd = 24 * 60 - clockMinutes(NIGHT_START) + clockMinutes(NIGHT_END);
  const maxWrap = wrapMinute(SESSION_END);
  const binSize = 30;
  const histogram = [];
  for (let start = 0; start <= maxWrap; start += binSize) {
    const end = start + binSize;
    histogram.push({
      start,
      end,
      label: formatTimeLabel(wrapToClock(start)),
      session: start <= overnightEnd ? "night" : "day",
      topCount: complete.filter((day) => day.topWrap != null && day.topWrap >= start && day.topWrap < end).length,
      bottomCount: complete.filter((day) => day.bottomWrap != null && day.bottomWrap >= start && day.bottomWrap < end).length,
    });
  }
  return {
    volatility: complete.map((day) => ({ date: day.date, rangePoints: day.rangePoints, orWidth: day.orWidth })),
    extremes: complete.map((day) => ({
      date: day.date,
      topTime: day.topTime,
      topLabel: day.topLabel,
      topWrap: day.topWrap,
      topSession: day.topSession,
      bottomTime: day.bottomTime,
      bottomLabel: day.bottomLabel,
      bottomWrap: day.bottomWrap,
      bottomSession: day.bottomSession,
      dayHigh: day.dayHigh,
      dayLow: day.dayLow,
      allHigh: day.allHigh,
      allLow: day.allLow,
    })),
    wrapExtremes: complete.map((day) => ({
      date: day.date,
      topTime: day.wrapTopTime,
      topWrap: day.wrapTopWrap,
      topSession: day.wrapTopSession,
      bottomTime: day.wrapBottomTime,
      bottomWrap: day.wrapBottomWrap,
      bottomSession: day.wrapBottomSession,
    })),
    histogram,
    breakout: complete.map((day) => ({
      date: day.date,
      firstBreak: day.firstBreak,
      breakoutMfe: day.breakoutMfe,
      falseMfe: day.falseMfe,
    })),
  };
}

function runAutoStrategies(bars, options = {}) {
  const lookback = Math.min(120, Math.max(1, Math.round(Number(options.days) || 10)));
  const rewardRisk = Math.min(10, Math.max(0.5, Number(options.rewardRisk) || 2));
  const sessions = groupDaySessions(Array.isArray(bars) ? bars : []);
  const usable = sessions.filter((session) => {
    const dayBars = session.dayBars?.length ? session.dayBars : session.bars.filter(isDaySessionBar);
    const orBars = dayBars.filter(isOpeningRangeBar);
    const closed = dayBars.some((bar) => clock(bar) >= SESSION_END);
    return orBars.length >= 10 && closed;
  });
  const selected = usable.slice(-lookback);
  const days = selected.map((session) => analyzeDay(session, rewardRisk));
  return {
    ok: true,
    symbol: "HK.HSImain",
    timeframe: "1m",
    days,
    summary: summarize(days, rewardRisk),
    graphs: buildGraphs(days),
  };
}

module.exports = {
  OR_START,
  OR_END,
  isOpeningRangeBar,
  isDaySessionBar,
  isNightBar,
  sessionDate,
  runAutoStrategies,
  analyzeDay,
  groupDaySessions,
};
