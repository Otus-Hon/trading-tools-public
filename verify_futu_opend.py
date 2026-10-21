#!/usr/bin/env python3
"""Verify a local Futu OpenD quote connection with one HSI snapshot request."""

import os
import sys


HOST = os.environ.get("FUTU_HOST", "127.0.0.1")
PORT = int(os.environ.get("FUTU_PORT", "11111"))
SYMBOL = "HK.800000"


def main() -> int:
    try:
        from futu import OpenQuoteContext, RET_OK
    except ImportError:
        print("ERROR: The official futu-api package is not installed.", file=sys.stderr)
        print("Install it with: python -m pip install -r requirements-futu.txt", file=sys.stderr)
        return 2

    quote_context = None
    try:
        print(f"Connecting to Futu OpenD at {HOST}:{PORT} ...")
        quote_context = OpenQuoteContext(host=HOST, port=PORT)

        result, data = quote_context.get_market_snapshot([SYMBOL])
        if result != RET_OK:
            print(f"ERROR: Snapshot request failed for {SYMBOL}.", file=sys.stderr)
            print(f"OpenD response: {data}", file=sys.stderr)
            print(
                "Check that OpenD is connected and that HK market-data permission is active.",
                file=sys.stderr,
            )
            return 1

        print(f"SUCCESS: Received market snapshot for {SYMBOL}\n")
        if hasattr(data, "columns") and hasattr(data, "to_string"):
            useful_columns = [
                "code",
                "name",
                "update_time",
                "last_price",
                "open_price",
                "high_price",
                "low_price",
                "prev_close_price",
                "turnover",
                "sec_status",
            ]
            available_columns = [column for column in useful_columns if column in data.columns]
            print(data.loc[:, available_columns].to_string(index=False))
        else:
            print(data)
        return 0
    except (ConnectionError, OSError) as exc:
        print(f"ERROR: Could not connect to OpenD at {HOST}:{PORT}: {exc}", file=sys.stderr)
        print(f"Confirm that OpenD is running and API Port {PORT} is enabled.", file=sys.stderr)
        return 1
    except Exception as exc:
        print(f"ERROR: Futu API verification failed: {exc}", file=sys.stderr)
        print(
            "Confirm the OpenD connection, API port, login state, and HK LV1 permission.",
            file=sys.stderr,
        )
        return 1
    finally:
        if quote_context is not None:
            quote_context.close()


if __name__ == "__main__":
    raise SystemExit(main())
