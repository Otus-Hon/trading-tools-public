# Trading Tools market-data contract

| Displayed metric | Authoritative source | Exact instrument/field | Unit and scope | Provider cadence |
|---|---|---|---|---|
| HSI live price/OHLC | Futu OpenD | `HK.800000` snapshot and daily bars | HSI cash-index points | Poll every 5 seconds |
| HSI chart volume | Futu OpenD | `HK.HSImain.volume` | Contracts in Futu's rolling main contract | Poll live every 5 seconds; daily history no more than every 60 seconds |
| Official OI history | HKEX daily HSI futures report | `All Contracts Total` → Open Interest / Change in OI | Contracts across all listed HSI futures months | Previous completed trading day |
| Live futures position | Futu OpenD | `HK.HSImain.future_position` and `future_position_change` | Position in Futu's rolling main contract; never splice into HKEX total history | Poll every 5 seconds and display separately |
| HSI futures expiry countdown | Futu OpenD | Exact front calendar-month HSI contract and its `last_trade_time` | Calendar days from the current HKT date; keep the expiring month through its final HKT date, show `今天期結` at 0, and roll on the following date | Refresh contract metadata at most every 60 seconds |
| CBBC recovery levels | Futu OpenD | Complete paginated universe of NORMAL-status HSI bull/bear CBBCs, grouped by exact `recovery_price`; sum `street_volume` | Outstanding street volume at recovery price | Poll every 5 seconds; publish only a complete verified pagination result |
| CBBC outstanding bands mirror | J.P. Morgan provider endpoint | HSI 100-point bands; `sdate` is outstanding date and `stime` is publication time | Provider-defined outstanding amount. General knockout alerts fire only when live Futu cash reaches the drawn line (bear `end + 1`, bull `start - 1`), including bands that have dropped out of the outstanding feed | Usually previous trading day's outstanding data, published next morning |
| Long/short money flow | CITIC Warrants | HSI `mtype=long` / `mtype=short`, `mflow` | HKD millions, daily rolling window | Completed daily data; refetch no more than every 5 minutes |
| Related daily markets | Yahoo chart endpoint | Exact displayed symbol | Daily closes | Server cache 15 minutes |
| 0700/9988/0005 live point | Futu OpenD | `HK.00700`, `HK.09988`, `HK.00005` snapshot `last_price` and `prev_close_price`; percent is `(last_price - prev_close_price) / prev_close_price` | HKD last trade and percent change versus the same Futu snapshot's previous close | Poll every 5 seconds; a Yahoo history reread must never replace the verified Futu header/current bar |
| Backtest candles | Futu OpenD | `HK.HSImain` native `1m`/`15m`/`4h`/`1d` history stored in private SQLite storage | Rolling main-contract futures OHLC; timestamp-keyed upsert, never delete older bars | Use completed Hong Kong sessions only. The public worker runs every five minutes, prioritizes a missing closed-session tail, then backfills 1-minute data in 30-day chunks to a fixed 120-session target. Do not poll today's in-progress session. Mark stale if the last bar is behind the last closed HKT session |

## Invariants

- `HK.HSImain` is a main continuous futures instrument. Contract rolls make its position series discontinuous.
- HKEX `All Contracts Total` is a different aggregation and has source priority for completed dates.
- Futu-mode charts must not use Tencent as a competing live HSI source.
- Futures expiry must come from the exact Futu calendar-month contract's `last_trade_time`, not a guessed weekday rule.
- `HK.HSImain.origin_code` must not drive the expiry display because a liquidity roll can occur before the expiring contract's final trading date has ended.
- The expiry contract must remain the front calendar month while `last_trade_time >= current HKT date`; only a later HKT date may select the next month.
- `cached`, `stale`, `liveUnavailable`, provider timestamp, and source identity are data, not decoration.
- CBBC aggregation must cover every product reported by Futu's `all_count`; a first page or any other partial pagination result must never be labeled complete.
- A five-second dashboard refresh does not authorize five-second refetches of daily history providers.
- Proxy fallbacks (`3032.HK`, `2823.HK`, `CNY=X`) must remain explicitly labelled and must never be described as the named underlying/future.

## Audit evidence

Capture:

- row counts and min/max dates per SQLite source;
- latest provider timestamp and its HKT age;
- latest official HKEX date/value/change;
- latest Futu main-contract position;
- money-flow long/short latest dates and row counts;
- CBBC publication time and outstanding date;
- source conflicts, impossible OHLC, duplicate dates, and stale payloads.

## HSI intraday dialog

- Futu OpenD `HK.800000`, native `K_15M` OHLC in HSI spot-index points; at least 850 bars from a paginated 90-day window. Convert provider Hong Kong timestamps to epoch seconds.
- `/api/futu/hsi-intraday` persists verified spot candles under the configured private data directory, caches provider history for 60 seconds, and is reread every five seconds while open. Validate symbol, interval and minimum history on provider responses and saved caches.
- Plot Futu CBBC recovery levels directly on the spot price scale without any futures-basis adjustment. Keep daily money flow/open interest in their existing daily workflows.
- Preserve verified candles on transient failure and expose stale/unavailable state. Keep the free crosshair and centred dismissible dialog.
