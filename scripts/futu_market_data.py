#!/usr/bin/env python3
"""Live HSI market-data bridge: cash price, futures volume, and Futu CBBC levels."""

import json
import math
import sys
import argparse
import os
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo


HOST = os.environ.get("FUTU_HOST", "127.0.0.1")
PORT = int(os.environ.get("FUTU_PORT", "11111"))
CASH_SYMBOL = "HK.800000"
FUTURES_SYMBOL = "HK.HSImain"
RIGHT_PANEL_SYMBOLS = ["HK.00700", "HK.09988", "HK.00005"]
HK_TZ = ZoneInfo("Asia/Hong_Kong")
PROJECT_ROOT = os.path.dirname(os.path.dirname(__file__))
DATA_DIR = os.path.abspath(os.environ.get(
    "TRADING_TOOLS_DATA_DIR",
    os.path.join(PROJECT_ROOT, "private-data", "runtime"),
))
OI_HISTORY_PATH = os.path.join(DATA_DIR, "futu_open_interest.json")


def clean_number(value, default=0.0):
    try:
        number = float(value)
        return number if math.isfinite(number) else default
    except (TypeError, ValueError):
        return default


def optional_number(value):
    """Return a finite provider number or None without inventing a zero."""
    try:
        number = float(value)
        return number if math.isfinite(number) else None
    except (TypeError, ValueError):
        return None


def fetch_history(context, code, start, end):
    from futu import AuType, KLType, RET_OK

    frames = []
    page_key = None
    while True:
        ret, data, page_key = context.request_history_kline(
            code,
            start=start,
            end=end,
            ktype=KLType.K_DAY,
            autype=AuType.NONE,
            max_count=1000,
            page_req_key=page_key,
        )
        if ret != RET_OK:
            raise RuntimeError(f"{code} history failed: {data}")
        if data is not None and not data.empty:
            frames.append(data)
        if page_key is None:
            break
    if not frames:
        return []

    import pandas as pd

    frame = pd.concat(frames, ignore_index=True).drop_duplicates(subset=["time_key"]).sort_values("time_key")
    return [
        {
            "date": str(row.time_key)[:10],
            "open": clean_number(row.open),
            "high": clean_number(row.high),
            "low": clean_number(row.low),
            "close": clean_number(row.close),
            "volume": clean_number(row.volume),
        }
        for row in frame.itertuples(index=False)
    ]


def fetch_snapshot(context, codes):
    from futu import RET_OK

    ret, frame = context.get_market_snapshot(codes)
    if ret != RET_OK:
        raise RuntimeError(f"Snapshot failed: {frame}")
    rows = {}
    for row in frame.to_dict("records"):
        price = clean_number(row.get("last_price"))
        last_close = optional_number(row.get("prev_close_price"))
        change_percent = (
            ((price - last_close) / last_close) * 100
            if price > 0 and last_close is not None and last_close > 0
            else None
        )
        rows[str(row.get("code"))] = {
            "price": price,
            "lastClose": last_close,
            "changePercent": change_percent,
            "open": clean_number(row.get("open_price")),
            "high": clean_number(row.get("high_price")),
            "low": clean_number(row.get("low_price")),
            "volume": clean_number(row.get("volume")),
            "turnover": clean_number(row.get("turnover")),
            "openInterest": clean_number(row.get("future_position")),
            "openInterestChange": clean_number(row.get("future_position_change")),
            "updateTime": str(row.get("update_time") or ""),
        }
    return rows


def contract_code_for_month(day):
    return f"HK.HSI{day.year % 100:02d}{day.month:02d}"


def next_month(day):
    if day.month == 12:
        return date(day.year + 1, 1, 1)
    return date(day.year, day.month + 1, 1)


def select_unexpired_contract(contract_rows, today):
    """Keep the front calendar-month contract through its final trading date."""
    for code, row in contract_rows:
        expiry_date = str(row.get("last_trade_time") or "")[:10]
        try:
            expiry_day = date.fromisoformat(expiry_date)
        except ValueError:
            continue
        if expiry_day >= today:
            return code, row, expiry_date
    return None


def fetch_futures_contract(context, today=None):
    """Resolve the front calendar contract without following an early HSImain roll."""
    from futu import RET_OK

    hk_today = today or datetime.now(HK_TZ).date()
    candidate_codes = [
        contract_code_for_month(hk_today),
        contract_code_for_month(next_month(hk_today)),
    ]
    contract_rows = []
    for code in candidate_codes:
        ret, contract_frame = context.get_future_info([code])
        if ret == RET_OK and contract_frame is not None and not contract_frame.empty:
            contract_rows.append((code, contract_frame.iloc[0].to_dict()))

    selected = select_unexpired_contract(contract_rows, hk_today)
    if selected is None:
        return None
    contract_code, contract_row, expiry_date = selected

    return {
        "continuousCode": FUTURES_SYMBOL,
        "contractCode": contract_code,
        "contractName": str(contract_row.get("name") or ""),
        "expiryDate": expiry_date,
        "exchange": str(contract_row.get("exchange") or ""),
        "source": "Futu get_future_info",
        "selectionPolicy": "front_calendar_month_until_expiry_date_end_hkt",
    }


def record_open_interest(snapshot):
    """Persist one end-of-latest-poll OI value per HK date, sourced only from Futu."""
    value = clean_number(snapshot.get("openInterest"))
    change = clean_number(snapshot.get("openInterestChange"))
    if value <= 0:
        return []
    update_time = str(snapshot.get("updateTime") or "")
    date = update_time[:10] if len(update_time) >= 10 else datetime.now(HK_TZ).date().isoformat()
    history = []
    try:
        with open(OI_HISTORY_PATH, "r", encoding="utf-8") as source:
            loaded = json.load(source)
            if isinstance(loaded, list):
                history = loaded
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        pass
    by_date = {str(item.get("date")): item for item in history if isinstance(item, dict) and item.get("date")}
    by_date[date] = {"date": date, "value": value, "change": change}
    history = sorted(by_date.values(), key=lambda item: item["date"])[-1500:]
    try:
        os.makedirs(os.path.dirname(OI_HISTORY_PATH), exist_ok=True)
        temporary = f"{OI_HISTORY_PATH}.tmp"
        with open(temporary, "w", encoding="utf-8") as target:
            json.dump(history, target, ensure_ascii=False, separators=(",", ":"))
        os.replace(temporary, OI_HISTORY_PATH)
    except OSError:
        # The live response remains usable even if local persistence is unavailable.
        pass
    return history


def fetch_cbbc(context):
    from futu import RET_OK, SortField, WarrantStatus, WrtType
    from futu.quote.quote_get_warrant import Request

    rows = []
    expected_count = None
    begin = 0
    while expected_count is None or begin < expected_count:
        req = Request()
        req.begin = begin
        req.num = 200
        req.type_list = [WrtType.BULL, WrtType.BEAR]
        req.status = WarrantStatus.NORMAL
        # Code order is stable while pages are being read. Sorting by the live
        # street-volume field can move a product between pages and cause a
        # duplicate or omission in a multi-page snapshot.
        req.sort_field = SortField.CODE
        req.ascend = True
        ret, result = context.get_warrant(CASH_SYMBOL, req)
        if ret != RET_OK:
            raise RuntimeError(f"CBBC page at offset {begin} failed: {result}")
        frame, last_page, all_count = result
        page_rows = frame.to_dict("records") if frame is not None else []
        expected_count = int(all_count)
        rows.extend(page_rows)
        begin += len(page_rows)
        if last_page:
            break
        if not page_rows:
            raise RuntimeError(
                f"CBBC pagination stopped at {begin} of {expected_count} rows"
            )

    # A partial universe produces plausible-looking but incorrect recovery-level
    # totals. Never publish it as a verified CBBC snapshot.
    unique_rows = {}
    for index, row in enumerate(rows):
        product_code = str(row.get("stock") or row.get("code") or f"row-{index}")
        unique_rows[product_code] = row
    if expected_count is None or len(unique_rows) != expected_count:
        raise RuntimeError(
            f"CBBC snapshot incomplete: fetched {len(unique_rows)} of {expected_count or 0} products"
        )
    rows = list(unique_rows.values())

    levels = {}
    active_count = 0
    for row in rows:
        side = str(row.get("type") or "").upper()
        recovery = clean_number(row.get("recovery_price"), default=float("nan"))
        status = str(row.get("status") or "")
        if side not in {"BULL", "BEAR"} or not math.isfinite(recovery):
            continue
        if status == "NORMAL":
            active_count += 1
        else:
            # Only active products should contribute to current recovery-price lines.
            continue
        key = (side, recovery)
        item = levels.setdefault(
            key,
            {"side": side.lower(), "price": recovery, "products": 0, "streetVolume": 0.0, "tradedVolume": 0.0},
        )
        item["products"] += 1
        item["streetVolume"] += clean_number(row.get("street_vol"))
        item["tradedVolume"] += clean_number(row.get("volume"))

    ranked = sorted(
        levels.values(),
        key=lambda item: (item["streetVolume"], item["tradedVolume"]),
        reverse=True,
    )
    return ranked, int(expected_count), int(expected_count)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--live-only", action="store_true")
    parser.add_argument("--skip-cbbc", action="store_true")
    parser.add_argument("--cbbc-only", action="store_true")
    args = parser.parse_args()
    try:
        from futu import OpenQuoteContext
    except ImportError:
        print(json.dumps({"ok": False, "error": "futu-api is not installed."}))
        return 2

    today = datetime.now(HK_TZ).date()
    start = (today - timedelta(days=730)).isoformat()
    context = None
    try:
        context = OpenQuoteContext(host=HOST, port=PORT)
        if args.cbbc_only:
            levels, total_cbbc, active_cbbc = fetch_cbbc(context)
            fetched_at = datetime.now(HK_TZ).isoformat()
            print(json.dumps({
                "ok": True,
                "cbbcLevels": levels,
                "cbbcTotal": total_cbbc,
                "cbbcActive": active_cbbc,
                "cbbcRowsFetched": active_cbbc,
                "cbbcComplete": active_cbbc == total_cbbc,
                "cbbcFetchedAt": fetched_at,
            }, ensure_ascii=False, separators=(",", ":")))
            return 0
        candles = []
        futures_contract = None
        if not args.live_only:
            cash = fetch_history(context, CASH_SYMBOL, start, today.isoformat())
            futures = fetch_history(context, FUTURES_SYMBOL, start, today.isoformat())
            futures_contract = fetch_futures_contract(context)
            futures_by_date = {bar["date"]: bar for bar in futures}
            candles = [
                {
                    **bar,
                    "volume": futures_by_date.get(bar["date"], {}).get("volume", 0),
                }
                for bar in cash
            ]
        snapshots = fetch_snapshot(context, [CASH_SYMBOL, FUTURES_SYMBOL, *RIGHT_PANEL_SYMBOLS])
        open_interest_history = record_open_interest(snapshots.get(FUTURES_SYMBOL, {}))
        levels, total_cbbc, active_cbbc = ([], 0, 0)
        if not args.skip_cbbc:
            levels, total_cbbc, active_cbbc = fetch_cbbc(context)
        print(
            json.dumps(
                {
                    "ok": True,
                    "priceSymbol": CASH_SYMBOL,
                    "volumeSymbol": FUTURES_SYMBOL,
                    "futuresContract": futures_contract,
                    "candles": candles,
                    "liveOnly": args.live_only,
                    "snapshots": snapshots,
                    "openInterestHistory": open_interest_history,
                    "cbbcLevels": levels,
                    "cbbcTotal": total_cbbc,
                    "cbbcActive": active_cbbc,
                    "cbbcRowsFetched": active_cbbc,
                    "cbbcComplete": active_cbbc == total_cbbc if not args.skip_cbbc else False,
                    "cbbcFetchedAt": datetime.now(HK_TZ).isoformat() if not args.skip_cbbc else None,
                    "fetchedAt": datetime.now(HK_TZ).isoformat(),
                    "definitions": {
                        "price": "Futu HK.800000 HSI cash index",
                        "volume": "Futu HK.HSImain rolling main-contract traded contracts",
                        "openInterest": "Futu HK.HSImain rolling main-contract position; not HKEX all-contract total",
                        "expiry": "Futu front calendar-month HSI contract last_trade_time; keep the expiring month through its final HKT date",
                        "cbbc": "Futu NORMAL-status HSI CBBC recovery-price levels aggregated by exact price",
                    },
                },
                ensure_ascii=False,
                separators=(",", ":"),
            )
        )
        return 0
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc), "hint": f"Confirm Futu OpenD is connected on {HOST}:{PORT}."}))
        return 1
    finally:
        if context is not None:
            context.close()


if __name__ == "__main__":
    sys.exit(main())
