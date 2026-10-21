Trading Tools — HSI dashboard, market data, and backtesting

> **Required before any change or build:** read this file, `REQUIREMENTS.md`, and `AGENTS.md` completely. After implementation, append the user's request and the work performed to the log in `REQUIREMENTS.md`.

## Overview
- Next.js dashboard showing Futu `HK.800000` Hang Seng Index cash candles, Futu `HK.HSImain` main-contract volume, Futu CBBC recovery levels, CITIC long/short money flow, and HKEX HSI futures total open interest.
- Runtime data is stored in the ignored `private-data/runtime/` directory. SQLite is the source of truth and JSON mirrors stay private.
- The Chart Data and image-search/upload features are intentionally excluded from the open-source application.
- Auto-refresh: the Market Data dashboard rereads the complete verified data state every 5 seconds. Live Futu fields are polled every 5 seconds; daily providers use the controlled cadences below.

## Verified market-data contract

| Metric | Source and exact scope | Refresh behavior |
|---|---|---|
| HSI live price/OHLC | Futu OpenD `HK.800000` cash index | 5 seconds |
| HSI chart volume | Futu OpenD `HK.HSImain` rolling main contract | Live 5 seconds; full daily history uses the server cache |
| HSI futures expiry countdown | Futu OpenD exact front calendar-month HSI contract and its `last_trade_time` | Keep the expiring month through its final HKT date; roll on the next date; metadata at most every 60 seconds |
| Official open-interest line | HKEX HSI futures daily report, `All Contracts Total` | Previous completed trading day |
| Live futures position | Futu `HK.HSImain.future_position` | 5 seconds; shown separately because it is not the HKEX total |
| CBBC recovery levels | Complete paginated Futu NORMAL-status HSI CBBC universe grouped by exact recovery price | 5-second polling; only complete verified pagination results are published |
| CBBC outstanding-band mirror | J.P. Morgan HSI band endpoint | Provider publication cadence; `sdate` may be the prior trading day |
| Long/short money flow | CITIC HSI daily long/short endpoints | SQLite reread every cycle; provider refetch at most every 5 minutes |
| Related daily markets | Yahoo daily chart endpoint | 15-minute server cache; disclosed ETF/FX proxies when the primary symbol is unavailable |
| 0700/9988/0005 card quote | Futu OpenD snapshot `last_price` and `prev_close_price`; percent is derived from that pair | 5 seconds; Yahoo supplies chart history only and cannot replace the verified card quote |

Never join values merely because they share a date. Provider, instrument, field, aggregation scope, unit, and timestamp must all match. In particular, Futu `HK.HSImain` is a rolling main contract and its position must never be connected to HKEX `All Contracts Total`.

## Stack & layout
- Web: Next.js 16, React 19, Lightweight Charts, ECharts.
- API (web): Next API routes under `app/api/`.
- Data: SQLite via `better-sqlite3` in ignored `private-data/runtime/` storage.

Directory highlights
```
app/                     # Next.js app router pages/components/API routes
app/api/cbbc/*           # CBBC refresh + latest endpoints (writes DB + JSON)
app/api/moneyflow/*      # Money-flow refresh + latest endpoints
app/api/hsi/             # HSI daily candles proxy (Stooq)
app/components/          # HSI dashboard and backtesting components
private-data/runtime/    # Local SQLite/JSON/cache state (ignored by Git)
scripts/                 # Fetchers, bridges, tests, and utilities
```

## Quick start
1) Node setup (root; the project pins Node in `.nvmrc` so native SQLite bindings match the app runtime):
   ```bash
   nvm use
   npm install
   # if better-sqlite3 needs rebuilding: npm rebuild better-sqlite3
   ```
2) Run the app:
   ```bash
   npm run dev
   ```
   - Before the server starts, `ensure:sqlite` opens an in-memory SQLite database with the active Node runtime. If the native ABI is incompatible, it automatically runs `npm rebuild better-sqlite3` and verifies the rebuilt binding.
   - Web only: `npm run dev:web`
3) Open `http://localhost:3000`; the root route redirects to `/market-data`.

Set `TRADING_TOOLS_DATA_DIR` to use a private data directory outside the checkout. When unset, the app uses `private-data/runtime/`, which is ignored by Git.

## Data refresh & storage
- SQLite tables (auto-created):
  - `money_flow_long`, `money_flow_long_meta`
  - `money_flow_short`, `money_flow_short_meta`
  - `hsi_open_interest`, `hsi_open_interest_meta`
  - `cbbc_meta`, `cbbc_rows`
- Private JSON mirrors are for inspection only. SQLite is the application source of truth. No generated market data is written under `public/`.
- Refresh buttons call:
  - `POST /api/cbbc/refresh` → fetch JP/SocGen data, upsert DB, write JSON mirror.
  - `POST /api/moneyflow/refresh` → fetch CITIC long/short money flow, upsert SQL first, then write complete-history JSON mirrors.
  - `GET /api/hkex/open-interest` → migrate/fetch HKEX/Futu open interest, upsert SQL first, then return complete SQL history.
  - `POST /api/backtest/refresh` → fetch the latest completed Futu `HK.HSImain` tail (not today's in-progress session), upsert into `private-data/runtime/backtest.sqlite`, and preserve older stored bars. App open skips OpenD when the last closed session is already stored. The Backtest **Refresh data** button can refetch that closed tail.
- Fetch scripts (manual/cron):
  - `npm run fetch` (CBBC), `npm run fetch:watch` (loop every 60s)
  - `npm run fetch:moneyflow:long`
- The Market Data page uses Futu `HK.800000` daily candles and `HK.HSImain` volume. `/api/hsi?years=5` remains the non-Futu fallback route and uses Stooq/Yahoo with SQLite preservation.
- The Backtest page Auto strategies view rereads stored `HK.HSImain` 1-minute candles from private SQLite storage for a typed lookback of 1–120 complete sessions, excluding today. Volatility is the day-session high–low from 09:15 to the 16:30 close. Daily top/bottom use the full futures wrap, including night 17:15–03:00. Opening-range follow-through and volatility include rolling EMA lines over up to five shown sessions with the latest EMA point value. Charts stay at a compact fixed height for long lookbacks, sample crowded axis labels, and retain exact per-date values in hover titles; the day-by-day table is collapsed by default. It does not invent bars. OpenD is called only if the last closed session is missing.
- The five-second cycle preserves chart geometry and viewport. It does not force-refetch daily Yahoo/CITIC histories every five seconds.

## Frontend behavior
- `MacdBacktest`:
  - Loads Futu `HK.HSImain` candles from private SQLite storage through the last completed Hong Kong session.
  - Does not keep fetching today's in-progress bars. **Refresh data** may refetch the last closed session.
  - Python source is the single configuration surface. Its top-level literal `BACKTEST` dictionary sets timeframe, completed-session count, starting capital, spread/slippage/commission, risk, point value, margin, execution mode, and ambiguous same-bar policy. The UI has no duplicate manual configuration toolbar.
  - **Copy AI Prompt** explains and requires the complete `BACKTEST` dictionary plus `strategy(bars)`, so generated code is paste-ready without follow-up UI settings.
- `HsiPanel`:
  - In Market Data mode, loads Futu `HK.800000` cash candles and `HK.HSImain` volume.
  - Uses Futu OpenD as the sole live HSI source in Futu mode; Tencent is only used by the non-Futu view.
  - Overlays CBBC levels from a **General / Detail** tab (default General). General uses the Backup Data 100-point outstanding-band calculation (`/api/cbbc/latest`). Detail uses exact Futu recovery prices from the complete NORMAL-status universe. Money flow and open interest stay on the chart in both views. KO alerts and the five-second live poll remain active in both views. General alerts only when the live cash high/low reaches the drawn band line (bear at `end + 1`, bull at `start - 1`) and keeps that band tracked if it leaves the outstanding feed. Detail alerts on the exact recovery price.
  - Long and short money-flow histograms from SQLite-backed endpoints.
  - Plots only HKEX all-contract-total open-interest history as the continuous line on a normal vertical scale and shows Futu main-contract position separately.
  - Warns if latest candle >7 days old. Auto-refreshes every 5 seconds and on **Refresh All Data**.
- The **15 minute** button opens a centred HSI spot (`HK.800000`) chart with at least 850 native bars, a free crosshair, and actual CBBC cash recovery levels. Spot history uses its own persisted cache and preserves the daily view.
- `FuturesExpiryProgress`:
  - Resolves the exact front calendar-month HSI contract through Futu and counts Hong Kong calendar days to its provider-reported `last_trade_time`.
  - Does not follow an early `HK.HSImain` liquidity roll: the expiring contract remains selected for its entire final HKT date, and the next month is selected only from the following date.
  - Uses a 30-day elapsed-time scale: gray marks elapsed days on the left and yellow marks the remaining distance to the right-side `期結` goal.
  - Shows `今天期結` on the final trading date and changes the full indicator to red.
  - Never guesses the expiry from a weekday rule.
- `CbbcEchartsPanel`:
  - Loads `/api/cbbc/latest`, builds 100-point buckets around spot, highlights heavy/new rows.

## Web API reference (Next.js)
- `GET /api/hsi?years=<int>` — daily candles (Stooq). Cache 300s.
- `POST /api/cbbc/refresh` — fetch + store CBBC; writes DB + JSON.
- `GET /api/cbbc/latest` — latest CBBC snapshot from SQLite.
- `POST /api/moneyflow/refresh` — upsert latest long/short provider windows to SQLite first; preserve and mirror complete accumulated history.
- `GET /api/moneyflow/long` — all stored long money-flow rows from SQLite.
- `GET /api/moneyflow/short` — all stored short money-flow rows from SQLite.
- `GET /api/hkex/open-interest` — all stored open-interest rows from SQLite; refreshes missing HKEX history when needed.
- `POST /api/backtest/refresh` — fetch completed Futu `HK.HSImain` candles into private SQLite storage for `1m`/`15m`/`4h`/`1d`; never deletes older stored bars; does not poll today's in-progress session unless already stored.
- `GET /api/backtest/candles` — read stored backtest candles through the last closed Hong Kong session; refreshes the Futu tail only when that closed session is missing or `refresh=1` is set.
- `GET /api/backtest/auto?days=<1-120>&rewardRisk=<number>` — run the Auto strategies panel on stored `HK.HSImain` 1-minute bars. Volatility uses 09:15–16:30 day-session range. Top/bottom include night futures. Opening-range breakout still uses 09:15–09:29.

## Environment knobs
- `TRADING_TOOLS_DATA_DIR`: absolute or relative private runtime-data directory. Defaults to `private-data/runtime/`.
- `MARKET_DB_PATH` and `BACKTEST_DB_PATH`: optional explicit SQLite overrides.
- `FUTU_PYTHON`: Python executable containing the official `futu-api` package. Windows virtual environments use `.venv-futu\\Scripts\\python.exe`; Unix environments use `.venv-futu/bin/python`.
- `FUTU_HOST` and `FUTU_PORT`: OpenD socket address. Defaults to `127.0.0.1:11111`; never expose this socket publicly.
- HSI range: `/api/hsi?years=<int>` (default 5).

## Windows Server deployment

The supported VPS layout and PowerShell installer are documented in [`deploy/windows/README.md`](deploy/windows/README.md). The VPS starts with an empty private data directory and fetches fresh provider data; historical local databases are not part of the public repository or deployment.

## Production notes
- `npm run dev`, `npm run dev:web`, `npm run build`, and `npm start` all run the SQLite ABI preflight before using the application.
- Runtime SQLite files are created inside the private data directory. Populate them through the refresh endpoints or fetch scripts after deployment.
- JSON mirrors remain private and the UI reads from SQLite-backed endpoints.
- Do not deploy or commit `private-data/`; provide persistent storage separately when the host filesystem is ephemeral.
- Before making an existing Git repository public, commit the private-file deletions and either publish with fresh history or scrub the old history. Deleting files from the current tree does not erase images or databases from earlier commits.

## Market-data audit skill

Before changing or diagnosing market data, use `skills/audit-real-market-data/SKILL.md`. Its deterministic audit is:

```bash
npm run audit:market-data
```

It validates source precedence, SQLite row integrity, provider timestamps, open-interest scope, money-flow alignment, CBBC publication dates, and Futu cache freshness.
