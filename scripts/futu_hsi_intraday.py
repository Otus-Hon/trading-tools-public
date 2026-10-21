"""Provider-native HSI spot 15-minute candles; timestamps are Hong Kong time."""
import json
import os
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
from futu import OpenQuoteContext, KLType, AuType, RET_OK

HOST = os.environ.get("FUTU_HOST", "127.0.0.1")
PORT = int(os.environ.get("FUTU_PORT", "11111"))

context = None
try:
    context = OpenQuoteContext(host=HOST, port=PORT)
    now = datetime.now(ZoneInfo("Asia/Hong_Kong"))
    def fetch_bars(symbol, days):
        bars = {}
        key = None
        while True:
            result, frame, key = context.request_history_kline(
                symbol, start=(now - timedelta(days=days)).date().isoformat(),
                end=now.date().isoformat(), ktype=KLType.K_15M, autype=AuType.NONE,
                max_count=1000, page_req_key=key)
            if result != RET_OK:
                raise RuntimeError(str(frame))
            for row in frame.itertuples(index=False):
                stamp = datetime.strptime(str(row.time_key), "%Y-%m-%d %H:%M:%S").replace(tzinfo=ZoneInfo("Asia/Hong_Kong"))
                time = int(stamp.timestamp())
                bars[time] = dict(time=time, open=float(row.open), high=float(row.high), low=float(row.low), close=float(row.close))
            if key is None:
                break
        return bars

    bars = fetch_bars("HK.800000", 90)
    if len(bars) < 850:
        raise RuntimeError("Fewer than 850 HSI spot 15-minute candles available")
    print(json.dumps(dict(ok=True, symbol="HK.800000", interval="15m", source="Futu OpenD", fetchedAt=now.isoformat(), candles=[bars[t] for t in sorted(bars)])))
except Exception as exc:
    print(json.dumps(dict(ok=False, error=str(exc))))
finally:
    if context is not None:
        context.close()
