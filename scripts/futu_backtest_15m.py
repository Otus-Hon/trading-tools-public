#!/usr/bin/env python3
"""Fetch a bounded HK.HSImain history chunk from local Futu OpenD."""

import argparse
import json
import os
from datetime import datetime
from zoneinfo import ZoneInfo


HK_TZ = ZoneInfo("Asia/Hong_Kong")


def emit(payload: dict, code: int = 0) -> None:
    print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    raise SystemExit(code)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--start", required=True)
    parser.add_argument("--end", required=True)
    parser.add_argument("--host", default=os.environ.get("FUTU_HOST", "127.0.0.1"))
    parser.add_argument("--port", default=int(os.environ.get("FUTU_PORT", "11111")), type=int)
    parser.add_argument("--timeframe", default="15m", choices=["1m", "15m", "4h", "1d"])
    args = parser.parse_args()

    try:
        datetime.strptime(args.start, "%Y-%m-%d")
        datetime.strptime(args.end, "%Y-%m-%d")
    except ValueError:
        emit({"ok": False, "error": "Dates must use YYYY-MM-DD."}, 2)

    try:
        import pandas as pd
        from futu import AuType, KLType, OpenQuoteContext, RET_OK
    except ImportError:
        emit({"ok": False, "error": "The configured Python environment is missing futu-api or pandas."}, 2)

    context = None
    try:
        ktypes = {"1m": KLType.K_1M, "15m": KLType.K_15M, "4h": KLType.K_240M, "1d": KLType.K_DAY}
        context = OpenQuoteContext(host=args.host, port=args.port)
        pages = []
        page_key = None
        while True:
            result, data, page_key = context.request_history_kline(
                "HK.HSImain",
                start=args.start,
                end=args.end,
                ktype=ktypes[args.timeframe],
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
            emit({"ok": True, "symbol": "HK.HSImain", "bars": [], "start": args.start, "end": args.end})

        frame = pd.concat(pages, ignore_index=True).drop_duplicates(subset=["time_key"]).sort_values("time_key")
        bars = []
        for row in frame.itertuples(index=False):
            local_time = datetime.strptime(str(row.time_key), "%Y-%m-%d %H:%M:%S").replace(tzinfo=HK_TZ)
            bars.append({
                "time": int(local_time.timestamp()),
                "timeKey": str(row.time_key),
                "open": float(row.open),
                "high": float(row.high),
                "low": float(row.low),
                "close": float(row.close),
                "volume": float(row.volume),
            })

        emit({
            "ok": True,
            "symbol": "HK.HSImain",
            "bars": bars,
            "start": args.start,
            "end": args.end,
            "count": len(bars),
            "timeframe": args.timeframe,
        })
    except Exception as exc:
        emit({
            "ok": False,
            "error": f"Futu {args.timeframe} history failed: {exc}",
            "hint": f"Confirm OpenD is connected at {args.host}:{args.port} and futures quote permission is active.",
        }, 1)
    finally:
        if context is not None:
            context.close()
    return 0


if __name__ == "__main__":
    main()
