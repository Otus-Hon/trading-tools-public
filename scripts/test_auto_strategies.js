const assert = require("node:assert/strict");
const { runAutoStrategies } = require("../lib/autoStrategies.js");

function candle(day, hhmm, open, high, low, close) {
  const [hours, minutes] = hhmm.split(":").map(Number);
  return {
    time: Date.parse(`${day}T${hhmm}:00+08:00`) / 1000,
    timeKey: `${day} ${hhmm}:00`,
    open, high, low, close, volume: 1,
    _hours: hours, _minutes: minutes,
  };
}

function openingRange(day, base) {
  const bars = [];
  for (let minute = 16; minute <= 30; minute += 1) {
    const clock = `09:${String(minute).padStart(2, "0")}`;
    bars.push(candle(day, clock, base, base + 10, base - 10, base));
  }
  return bars;
}

function session(day, extra) {
  const last = extra[extra.length - 1];
  const close = last ? last.close : 25000;
  return [...openingRange(day, 25000), ...extra, candle(day, "16:30", close, close + 1, close - 1, close)];
}

const bars = [
  ...session("2026-09-01", [
    candle("2026-09-01", "09:45", 25010, 25180, 25005, 25150),
    candle("2026-09-01", "15:00", 25150, 25160, 25090, 25120),
  ]),
  ...session("2026-09-02", [
    candle("2026-09-02", "10:05", 24990, 25005, 24820, 24840),
    candle("2026-09-02", "14:30", 24840, 24880, 24790, 24810),
  ]),
  ...session("2026-09-03", [
    candle("2026-09-03", "09:40", 25012, 25040, 24995, 25020),
    candle("2026-09-03", "11:00", 25020, 25022, 24850, 24870),
    candle("2026-09-03", "15:30", 24870, 24890, 24740, 24760),
  ]),
  ...session("2026-09-04", [
    candle("2026-09-04", "13:30", 25000, 25005, 24990, 24995),
  ]),
  ...session("2026-09-05", [
    candle("2026-09-05", "10:20", 24980, 24990, 24890, 24910),
    candle("2026-09-05", "11:10", 24910, 25060, 24900, 25040),
  ]),
];

const result = runAutoStrategies(bars, { days: 5, rewardRisk: 2 });
assert.equal(result.summary.lookbackDays, 5);
assert.equal(result.days[0].topTime, "09:45");
assert.equal(result.days[0].topSession, "day");
assert.equal(result.days[0].topLabel, "09:45 d");
assert.equal(result.days[0].firstBreak, "long");
assert.equal(result.days[0].breakoutMfe, 170);
assert.equal(result.days[1].firstBreak, "short");
assert.equal(result.days[2].falseBreak, "short");
assert.equal(result.days[2].falseRr.outcome, "TP");
assert.equal(result.days[4].falseBreak, "long");
assert.ok(result.summary.openingRangeBreakout.averageMfe > 0);
assert.ok(result.summary.falseBreakout.trades >= 2);
assert.equal(result.summary.dailyExtremes.topWindow.median, "09:40");
assert.ok(result.graphs.volatility.length === 5);
assert.equal(result.summary.volatility.scope.includes("09:15"), true);

const nightBars = [
  candle("2026-09-07", "21:00", 25200, 25350, 25190, 25280),
  candle("2026-09-08", "01:10", 25280, 25290, 24700, 24740),
  ...session("2026-09-08", [
    candle("2026-09-08", "09:45", 25010, 25180, 25005, 25150),
    candle("2026-09-08", "15:00", 25150, 25160, 25090, 25120),
  ]),
  ...session("2026-09-09", [
    candle("2026-09-09", "10:05", 24990, 25005, 24820, 24840),
    candle("2026-09-09", "14:30", 24840, 24880, 24790, 24810),
  ]),
  ...session("2026-09-10", [
    candle("2026-09-10", "09:40", 25012, 25040, 24995, 25020),
    candle("2026-09-10", "11:00", 25020, 25022, 24850, 24870),
    candle("2026-09-10", "15:30", 24870, 24890, 24740, 24760),
  ]),
  ...session("2026-09-11", [
    candle("2026-09-11", "13:30", 25000, 25005, 24990, 24995),
  ]),
  ...session("2026-09-12", [
    candle("2026-09-12", "10:20", 24980, 24990, 24890, 24910),
    candle("2026-09-12", "11:10", 24910, 25060, 24900, 25040),
  ]),
];
const nightResult = runAutoStrategies(nightBars, { days: 5, rewardRisk: 2 });
const monday = nightResult.days.find((day) => day.date === "2026-09-08");
assert.equal(monday.topTime, "09:45");
assert.equal(monday.topSession, "day");
assert.equal(monday.bottomTime, "09:16");
assert.equal(monday.bottomSession, "day");
assert.equal(monday.allHigh, 25350);
assert.equal(monday.wrapTopTime, "21:00");
assert.equal(monday.wrapBottomTime, "01:10");
assert.equal(monday.rangePoints, 190);
assert.ok(monday.rangePoints < monday.allRangePoints);
console.log("auto strategy tests passed");
