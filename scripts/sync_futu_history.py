#!/usr/bin/env python3
"""Import cached HK.HSImain candles and incrementally sync Futu OpenD into SQLite."""

import argparse
import glob
import json
import os
import sqlite3
import sys
import time
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo


ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = Path(os.environ.get("TRADING_TOOLS_DATA_DIR", ROOT / "private-data" / "runtime")).resolve()
DB_PATH = Path(os.environ.get("BACKTEST_DB_PATH", DATA_DIR / "backtest.sqlite")).resolve()
FUTU_HOST = os.environ.get("FUTU_HOST", "127.0.0.1")
FUTU_PORT = int(os.environ.get("FUTU_PORT", "11111"))
SYMBOL = "HK.HSImain"
HK_TZ = ZoneInfo("Asia/Hong_Kong")
TIMEFRAMES = ("1m", "15m", "4h", "1d")
CHUNK_DAYS = {"1m": 14, "15m": 180, "4h": 365, "1d": 730}


SCHEMA = """
CREATE TABLE IF NOT EXISTS candles (
  symbol TEXT NOT NULL, timeframe TEXT NOT NULL, time INTEGER NOT NULL,
  time_key TEXT NOT NULL, open REAL NOT NULL, high REAL NOT NULL,
  low REAL NOT NULL, close REAL NOT NULL, volume REAL NOT NULL DEFAULT 0,
  turnover REAL, source TEXT NOT NULL DEFAULT 'futu', fetched_at_utc TEXT NOT NULL,
  PRIMARY KEY (symbol, timeframe, time)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_candles_time_key ON candles(symbol, timeframe, time_key);
CREATE INDEX IF NOT EXISTS idx_candles_range ON candles(symbol, timeframe, time);
CREATE TABLE IF NOT EXISTS candle_sync_log (
  timeframe TEXT NOT NULL, range_start TEXT NOT NULL, range_end TEXT NOT NULL,
  row_count INTEGER NOT NULL, status TEXT NOT NULL, error TEXT,
  fetched_at_utc TEXT NOT NULL, PRIMARY KEY (timeframe, range_start, range_end)
);
"""


def connect():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(DB_PATH, timeout=30)
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA synchronous=NORMAL")
    db.executescript(SCHEMA)
    return db


def valid_bar(bar):
    try:
        return (
            int(bar["time"]) > 0
            and float(bar["high"]) >= max(float(bar["open"]), float(bar["close"]), float(bar["low"]))
            and float(bar["low"]) <= min(float(bar["open"]), float(bar["close"]), float(bar["high"]))
            and float(bar.get("volume", 0)) >= 0
        )
    except (KeyError, TypeError, ValueError):
        return False


def upsert(db, timeframe, bars, source):
    fetched_at = datetime.now(tz=ZoneInfo("UTC")).isoformat()
    rows = []
    rejected = 0
    for bar in bars:
        if not valid_bar(bar):
            rejected += 1
            continue
        rows.append((
            SYMBOL, timeframe, int(bar["time"]), str(bar["timeKey"]),
            float(bar["open"]), float(bar["high"]), float(bar["low"]), float(bar["close"]),
            float(bar.get("volume", 0)), float(bar["turnover"]) if bar.get("turnover") is not None else None,
            source, fetched_at,
        ))
    db.executemany("""
      INSERT INTO candles(symbol,timeframe,time,time_key,open,high,low,close,volume,turnover,source,fetched_at_utc)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(symbol,timeframe,time) DO UPDATE SET
        time_key=excluded.time_key,open=excluded.open,high=excluded.high,low=excluded.low,
        close=excluded.close,volume=excluded.volume,turnover=excluded.turnover,
        source=excluded.source,fetched_at_utc=excluded.fetched_at_utc
    """, rows)
    db.commit()
    return len(rows), rejected


def import_caches(db, timeframes):
    totals = {timeframe: 0 for timeframe in timeframes}
    for timeframe in timeframes:
        pattern = DATA_DIR / f"backtest-{timeframe}-cache" / "*.json"
        for filename in sorted(glob.glob(str(pattern))):
            try:
                payload = json.loads(Path(filename).read_text())
                count, _ = upsert(db, timeframe, payload.get("bars", []), "existing-json-cache")
                totals[timeframe] += count
            except Exception as exc:
                print(f"[cache] skipped {filename}: {exc}", file=sys.stderr)
        print(f"[cache] {timeframe}: processed {totals[timeframe]:,} rows", flush=True)
    return totals


def fetch_range(context, timeframe, start, end):
    import pandas as pd
    from futu import AuType, KLType, RET_OK
    ktypes = {"1m": KLType.K_1M, "15m": KLType.K_15M, "4h": KLType.K_240M, "1d": KLType.K_DAY}
    pages = []
    page_key = None
    while True:
        result, data, page_key = context.request_history_kline(
            SYMBOL, start=start, end=end, ktype=ktypes[timeframe], autype=AuType.NONE,
            max_count=1000, page_req_key=page_key,
        )
        if result != RET_OK:
            raise RuntimeError(str(data))
        if data is not None and not data.empty:
            pages.append(data)
        if page_key is None:
            break
    if not pages:
        return []
    frame = pd.concat(pages, ignore_index=True).drop_duplicates(subset=["time_key"]).sort_values("time_key")
    bars = []
    for row in frame.itertuples(index=False):
        local = datetime.strptime(str(row.time_key), "%Y-%m-%d %H:%M:%S").replace(tzinfo=HK_TZ)
        bars.append({
            "time": int(local.timestamp()), "timeKey": str(row.time_key),
            "open": float(row.open), "high": float(row.high), "low": float(row.low), "close": float(row.close),
            "volume": float(row.volume), "turnover": float(row.turnover),
        })
    return bars


def logged_success(db, timeframe, start, end):
    row = db.execute(
        "SELECT status FROM candle_sync_log WHERE timeframe=? AND range_start=? AND range_end=?",
        (timeframe, start, end),
    ).fetchone()
    return bool(row and row[0] == "ok")


def log_sync(db, timeframe, start, end, count, status, error=None):
    db.execute("""
      INSERT OR REPLACE INTO candle_sync_log(timeframe,range_start,range_end,row_count,status,error,fetched_at_utc)
      VALUES(?,?,?,?,?,?,?)
    """, (timeframe, start, end, count, status, error, datetime.now(tz=ZoneInfo("UTC")).isoformat()))
    db.commit()


def sync_opend(db, timeframes, start_date, end_date, pause):
    from futu import OpenQuoteContext
    context = OpenQuoteContext(host=FUTU_HOST, port=FUTU_PORT)
    try:
        for timeframe in timeframes:
            cursor = start_date
            while cursor <= end_date:
                chunk_end = min(end_date, cursor + timedelta(days=CHUNK_DAYS[timeframe] - 1))
                start, end = cursor.isoformat(), chunk_end.isoformat()
                if logged_success(db, timeframe, start, end):
                    cursor = chunk_end + timedelta(days=1)
                    continue
                try:
                    bars = fetch_range(context, timeframe, start, end)
                    inserted, rejected = upsert(db, timeframe, bars, "futu-opend")
                    log_sync(db, timeframe, start, end, inserted, "ok")
                    print(f"[futu] {timeframe} {start}..{end}: {inserted:,} rows ({rejected} rejected)", flush=True)
                except Exception as exc:
                    log_sync(db, timeframe, start, end, 0, "error", str(exc))
                    print(f"[futu] {timeframe} {start}..{end}: ERROR {exc}", file=sys.stderr, flush=True)
                    message = str(exc).lower()
                    if "quota" in message or "limit" in message or "頻率" in message or "60次" in message:
                        raise
                cursor = chunk_end + timedelta(days=1)
                if pause:
                    time.sleep(pause)
    finally:
        context.close()


def quality_report(db):
    report = {}
    for timeframe in TIMEFRAMES:
        row = db.execute("""
          SELECT COUNT(*), COUNT(DISTINCT time), COUNT(DISTINCT time_key),
                 MIN(time_key), MAX(time_key), COUNT(DISTINCT substr(time_key,1,10)),
                 SUM(CASE WHEN high < open OR high < close OR high < low OR low > open OR low > close OR volume < 0 THEN 1 ELSE 0 END)
          FROM candles WHERE symbol=? AND timeframe=?
        """, (SYMBOL, timeframe)).fetchone()
        report[timeframe] = {
            "rows": row[0], "uniqueTimes": row[1], "uniqueTimeKeys": row[2],
            "first": row[3], "last": row[4], "tradingDates": row[5], "invalidOhlcv": row[6] or 0,
        }
    print(json.dumps({"database": str(DB_PATH), "coverage": report}, indent=2, ensure_ascii=False))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--timeframes", default=",".join(TIMEFRAMES))
    parser.add_argument("--start", default="2000-01-01")
    parser.add_argument("--end", default=datetime.now(HK_TZ).date().isoformat())
    parser.add_argument("--import-cache", action="store_true")
    parser.add_argument("--fetch", action="store_true")
    parser.add_argument("--pause", type=float, default=0.25)
    parser.add_argument("--report", action="store_true")
    args = parser.parse_args()
    timeframes = tuple(value.strip() for value in args.timeframes.split(",") if value.strip())
    if not timeframes or any(value not in TIMEFRAMES for value in timeframes):
        raise SystemExit("Invalid --timeframes value.")
    start_date = date.fromisoformat(args.start)
    end_date = date.fromisoformat(args.end)
    db = connect()
    try:
        if args.import_cache:
            import_caches(db, timeframes)
        if args.fetch:
            sync_opend(db, timeframes, start_date, end_date, args.pause)
        if args.report or not (args.import_cache or args.fetch):
            quality_report(db)
    finally:
        db.close()


if __name__ == "__main__":
    main()
