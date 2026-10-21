#!/usr/bin/env python3
"""Fetch synchronized HSI futures 1-minute and 15-minute backtest windows from Futu OpenD."""

import argparse
import json
import os
import sys
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo


HOST = os.environ.get("FUTU_HOST", "127.0.0.1")
PORT = int(os.environ.get("FUTU_PORT", "11111"))
SYMBOL = "HK.HSImain"
MARKET_OPEN = "09:15:00"
REFERENCE_TIME = "09:30:00"
HK_TZ = ZoneInfo("Asia/Hong_Kong")
WINDOW_DAYS = 35
LONG_WINDOW_DAYS = 450


def emit(payload: dict, exit_code: int = 0) -> None:
    print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    raise SystemExit(exit_code)


def fetch_all(context, *, start: str, end: str, ktype):
    from futu import AuType, RET_OK

    pages = []
    page_key = None
    while True:
        result, data, page_key = context.request_history_kline(
            SYMBOL,
            start=start,
            end=end,
            ktype=ktype,
            autype=AuType.NONE,
            max_count=1000,
            page_req_key=page_key,
        )
        if result != RET_OK:
            raise RuntimeError(str(data))
        if data is not None and not data.empty:
            pages.append(data)
        if page_key is None:
            break

    if not pages:
        return []

    import pandas as pd

    frame = pd.concat(pages, ignore_index=True).drop_duplicates(subset=["time_key"])
    frame = frame.sort_values("time_key")
    bars = []
    for row in frame.itertuples(index=False):
        local_time = datetime.strptime(str(row.time_key), "%Y-%m-%d %H:%M:%S").replace(tzinfo=HK_TZ)
        bars.append(
            {
                "time": int(local_time.timestamp()),
                "timeKey": str(row.time_key),
                "open": float(row.open),
                "high": float(row.high),
                "low": float(row.low),
                "close": float(row.close),
                "volume": float(row.volume),
                "turnover": float(row.turnover),
            }
        )
    return bars


def session_anchor_index(bars: list[dict], date: str) -> int:
    """Return the first candle ending after the 09:15 futures day-session open."""
    return next(
        (
            i
            for i, bar in enumerate(bars)
            if bar["timeKey"].startswith(date)
            and "09:15:00" < bar["timeKey"][11:] < "12:00:00"
        ),
        -1,
    )


def trading_dates(bars: list[dict]) -> list[str]:
    dates = sorted({bar["timeKey"][:10] for bar in bars})
    return [date for date in dates if session_anchor_index(bars, date) >= 0]


def valid_dates(bars: list[dict], before: int, after: int) -> list[str]:
    valid = []
    for date in trading_dates(bars):
        open_index = session_anchor_index(bars, date)
        if open_index >= before and len(bars) - open_index >= after:
            valid.append(date)
    return valid


def slice_window(bars: list[dict], date: str, before: int, after: int) -> list[dict]:
    open_index = session_anchor_index(bars, date)
    if open_index < 0:
        raise ValueError(f"No {MARKET_OPEN[:5]} market-open candle is available for {date}.")
    if open_index < before or len(bars) - open_index < after:
        raise ValueError(
            f"Not enough surrounding data for {date}: need {before} bars before and {after} bars from market open."
        )
    return bars[open_index - before : open_index + after]


def slice_date_context(bars: list[dict], date: str, size: int = 200) -> list[dict]:
    """Return a fixed-size context window while allowing recent dates near the right edge."""
    anchor = next((i for i, bar in enumerate(bars) if bar["timeKey"].startswith(date)), -1)
    if anchor < 0:
        raise ValueError(f"No candle is available for {date}.")
    start = max(0, min(anchor - size // 2, len(bars) - size))
    return bars[start : start + size]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--date", required=True, help="Trading date in YYYY-MM-DD format")
    parser.add_argument("--host", default=HOST)
    parser.add_argument("--port", default=PORT, type=int)
    args = parser.parse_args()

    try:
        selected = datetime.strptime(args.date, "%Y-%m-%d").date()
    except ValueError:
        emit({"ok": False, "error": "Date must use YYYY-MM-DD format."}, 2)

    try:
        from futu import KLType, OpenQuoteContext
    except ImportError:
        emit(
            {
                "ok": False,
                "error": "The official futu-api package is not installed for the configured Python interpreter.",
            },
            2,
        )

    start = (selected - timedelta(days=WINDOW_DAYS)).isoformat()
    end = min(selected + timedelta(days=WINDOW_DAYS), datetime.now(HK_TZ).date()).isoformat()
    long_start = (selected - timedelta(days=LONG_WINDOW_DAYS)).isoformat()
    long_end = min(selected + timedelta(days=LONG_WINDOW_DAYS), datetime.now(HK_TZ).date()).isoformat()
    context = None
    try:
        context = OpenQuoteContext(host=args.host, port=args.port)
        bars_1m = fetch_all(context, start=start, end=end, ktype=KLType.K_1M)
        bars_15m = fetch_all(context, start=start, end=end, ktype=KLType.K_15M)
        bars_4h = fetch_all(context, start=long_start, end=long_end, ktype=KLType.K_240M)
        bars_day = fetch_all(context, start=long_start, end=long_end, ktype=KLType.K_DAY)

        dates_1m = set(valid_dates(bars_1m, 500, 500))
        dates_15m = set(valid_dates(bars_15m, 300, 300))
        dates = sorted(dates_1m & dates_15m)

        if args.date not in dates:
            nearest = min(dates, key=lambda date: abs((datetime.strptime(date, "%Y-%m-%d").date() - selected).days)) if dates else None
            emit(
                {
                    "ok": False,
                    "error": f"{args.date} is not a trading date with enough before/after candles.",
                    "suggestedDate": nearest,
                    "diagnostics": {
                        "bars1m": len(bars_1m),
                        "bars15m": len(bars_15m),
                        "marketOpenDates1m": trading_dates(bars_1m),
                        "marketOpenDates15m": trading_dates(bars_15m),
                    },
                },
                3,
            )

        selected_index = dates.index(args.date)
        reference_time = int(
            datetime.strptime(f"{args.date} {REFERENCE_TIME}", "%Y-%m-%d %H:%M:%S")
            .replace(tzinfo=HK_TZ)
            .timestamp()
        )
        emit(
            {
                "ok": True,
                "symbol": SYMBOL,
                "selectedDate": args.date,
                "marketOpenTime": reference_time,
                "previousDate": dates[selected_index - 1] if selected_index > 0 else None,
                "nextDate": dates[selected_index + 1] if selected_index + 1 < len(dates) else None,
                "bars15m": slice_window(bars_15m, args.date, 300, 300),
                "bars1m": slice_window(bars_1m, args.date, 500, 500),
                "bars4h": slice_date_context(bars_4h, args.date),
                "barsDay": slice_date_context(bars_day, args.date),
                "counts": {"bars15mBefore": 300, "bars15mAfter": 300, "bars1mBefore": 500, "bars1mAfter": 500},
                "sourceRange": {"start": start, "end": end},
            }
        )
    except Exception as exc:
        emit(
            {
                "ok": False,
                "error": f"Futu candle request failed: {exc}",
                "hint": f"Confirm OpenD is connected at {args.host}:{args.port} and HK quote permission is active.",
            },
            1,
        )
    finally:
        if context is not None:
            context.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
