# Trading Tools requirements and implementation log

This file is the durable source of truth for product behavior. It must be read together with `README.md` before every code change, build, or test.

## Non-negotiable requirements

### Refresh behavior

- The Market Data dashboard automatically rereads and renders the complete verified data state every 5 seconds.
- Five-second autoload includes HSI/Futu market data, CBBC data, long and short money flow, open interest, and the related-market panels.
- Live Futu snapshots are provider-polled every five seconds. Daily datasets may be reread from SQLite/cache every five seconds but must not be force-refetched from Yahoo, CITIC, or HKEX at tick frequency.
- Provider cadence must match metric cadence: Futu live 5 seconds, Futu daily history at most 60 seconds unless manually forced, CITIC at most 5 minutes, Yahoo daily bars 15 minutes, and HKEX reports only when the expected completed report is missing.
- Manual **Refresh All Data** triggers the same complete pipeline immediately.
- Backtest `HK.HSImain` history in private SQLite storage is refreshed from Futu OpenD through the last completed Hong Kong session. Today's in-progress session is not required and must not be polled in a loop. The public worker prioritizes a missing closed-session tail, then backfills 1-minute data in 30-day chunks to the fixed 120-session target. Timestamp-keyed upserts preserve older stored bars across restarts and deployments. Private/local **Refresh data** may refetch the closed-session tail. A failed refresh keeps last verified candles and marks them stale if they are behind the last closed session.
- Refreshing must not resize, shift, collapse, or reset the user's visible chart panel or logical time viewport.
- A transient request failure must preserve the last verified chart data.

### Money flow

- SQLite at `private-data/runtime/market.sqlite` (or `MARKET_DB_PATH`) is the source of truth.
- Both long and short money-flow series are required.
- Every provider fetch must be upserted into SQLite before the API reads or returns data.
- Provider responses are rolling windows. Upserts must accumulate history and must never delete older stored dates.
- Every page load/refresh must render all money-flow rows stored in SQLite that align with available chart candle dates, not only the provider's latest window.
- JSON files are inspection mirrors only. They must mirror the complete SQL history and must never replace SQL as the UI source.
- The non-private historical CITIC baseline is versioned in the source tree and inserted into SQLite on initialization with insert-only precedence. Live provider refreshes may update matching dates and continue accumulating newer dates; deployment must not require a separately transferred seed database.

### Open interest

- SQLite at `private-data/runtime/market.sqlite` (or `MARKET_DB_PATH`) is the source of truth for HSI futures open-interest history.
- HKEX historical reports and Futu `HK.HSImain` live snapshots must be upserted into SQLite before the API returns data.
- Open-interest upserts must accumulate history and must never delete older stored dates.
- Legacy JSON history must be migrated into SQLite without dropping rows. JSON remains an inspection mirror only.
- Every page load/refresh must render all stored open-interest rows that align with available chart candle dates.
- HKEX `All Contracts Total` is the only continuous open-interest line. Futu `HK.HSImain.future_position` is a rolling main-contract position and must be persisted and displayed separately, never spliced into the HKEX line.
- The official open-interest pane uses a normal vertical scale: higher contract totals display higher and lower totals display lower.

### Source identity and truthfulness

- The Futu Market Data page uses Futu OpenD `HK.800000` as its sole live HSI cash source. It must not mix a Tencent quote into a Futu-labelled candle or badge.
- Futu `HK.HSImain` volume is rolling main-contract futures volume, not cash-index volume and not all-contract volume.
- Every cached fallback must retain its last verified values and expose stale/unavailable state; cached data must never be promoted as a fresh tick.
- Proxy instruments must be visibly labelled as proxies and must never be described as the named underlying or future.
- Provider, exact symbol/field, aggregation scope, unit, and timestamp must be recorded before a metric can be joined or compared.
- The 0700, 9988, and 0005 card headers use Futu snapshot price, previous close, and change rate as one authoritative tuple; Yahoo daily-history rereads must never replace that tuple.
- Futu CBBC recovery-level totals must be aggregated from every NORMAL-status HSI bull/bear product reported by the provider's paginated result. A first page or incomplete pagination result must never be presented as a verified warrant snapshot.
- The Market Data chart presents CBBC in two explicit modes. General (default) uses the Backup Data 100-point outstanding-band calculation. Detail uses exact Futu recovery prices. Money flow and official open interest remain on the chart in both modes. Both modes keep knockout alerts and the five-second live Futu poll.
- General knockout alerts fire only when the live Futu cash range reaches the drawn line for a 100-point band: bear lines at `end + 1`, bull lines at `start - 1`. Entering the bucket without printing that line is not a knockout. A band that drops out of the outstanding feed stays in the session registry so a real line cross still alerts. Detail alerts remain on the exact recovery price. The first poll after open, a new session, or a tab change only records the baseline.
- The HSI futures expiry countdown must query Futu OpenD for the exact front calendar-month HSI contract and use that contract's `last_trade_time`; it must never infer expiry from a weekday rule.
- An early `HK.HSImain` liquidity roll must not change the expiry display. The expiring calendar-month contract remains selected throughout its provider-reported final HKT date, and the display rolls to the next month only on the following HKT date.
- Expiry is counted in Hong Kong calendar days on a 30-to-0 scale. The indicator must say `今天期結` and turn red on the provider-reported final trading date.
- The expiry progress uses gray for elapsed days on the left and yellow for the remaining distance to the right-side `期結` end goal.

### Change discipline

- Read `README.md`, `REQUIREMENTS.md`, and `AGENTS.md` before modifying or building.
- Do not delete or weaken existing data pipelines to solve rendering or layout issues.
- Record each user request and the corresponding implementation below.
- Validate row counts/source storage and observe at least one five-second refresh cycle in the running dashboard.
- App startup must verify that `better-sqlite3` loads with the active Node ABI and automatically rebuild it before Next.js starts when it does not.
- Market-data work must use `skills/audit-real-market-data/SKILL.md` and pass its audit script before delivery.
- Runtime databases, provider caches, mirrors, uploads, and user-generated images must remain under the Git-ignored `private-data/` root (or an explicitly configured external data directory), never under `public/` or another source-controlled path.
- The open-source navigation exposes only Main Data and Backtest. The removed Chart Data, image search, case upload/search, and image-processing services must not be reintroduced accidentally.

## Implementation log

### 2026-07-22 — Restore persistence and five-second refresh

User request:

- Create durable documentation that future work must read and update.
- Restore the required five-second complete-data autoload.
- Load all accumulated money-flow history from SQL, and save every fetch to SQL before reading it.
- Store open-interest history in SQL with the same save-first/read-after behavior.
- Stop breaking original behavior through undocumented changes.

Implementation:

- Added this requirements ledger and repository-level `AGENTS.md` instructions.
- Restored the five-second complete refresh in `HsiPanel` while retaining fixed toolbar/footer geometry and viewport preservation.
- Rebuilt `better-sqlite3` for the active Node runtime and removed the partial JSON read fallback.
- Made money-flow refresh upsert both long and short windows to SQLite first, read the complete accumulated SQL history, and then write complete JSON mirrors.
- Added SQLite tables and accessors for HSI open interest.
- Migrated legacy HKEX/Futu JSON history into SQLite, made the HKEX endpoint return SQL history, and made Futu live responses persist open interest before returning.

### 2026-07-23 — Make startup money flow and open interest reliable

User request:

- Always read the Markdown requirements before making changes.
- Fix money flow and open interest failing to load after reopening the Market Data app.

Implementation:

- Traced the blank panels to five-second refresh cleanup aborting money-flow and open-interest requests, plus duplicate startup refreshes receiving an HTTP 429 cooldown response.
- Found that the reopened dev server was running Node 22 (ABI 127) while `better-sqlite3` had been built by Node 20 (ABI 115), rebuilt the native module with the server's active Node runtime, and restored every SQLite-backed endpoint.
- Pinned the launcher and local setup to Node 22.23.0 through `.nvmrc` so reopening the app does not silently switch the native SQLite ABI again.
- Made the money-flow provider refresh single-flight, changed cooldown and provider-failure responses to return the verified SQLite history, and preserved complete-history SQL/JSON writes.
- Prevented five-second candle refreshes from aborting in-progress money-flow and open-interest reads, while retaining one complete refresh attempt per cycle and the last verified chart series.

### 2026-07-23 — Make the SQLite repair reusable on every startup

User request:

- Ensure the working money-flow and open-interest fix continues to work the next time the app is opened.
- Record the reusable procedure in the project Markdown files for future sessions.

Implementation:

- Added a startup preflight that opens an in-memory database using `better-sqlite3` and the active Node runtime.
- If the native binding has the wrong Node ABI, the preflight automatically rebuilds `better-sqlite3`, verifies the new binding, and only then starts Next.js.
- Applied the preflight to development, web-only development, production builds, and production startup.
- Updated `README.md`, `openserver.md`, `AGENTS.md`, and this durable implementation log with the pinned-Node and automatic-repair workflow.

### 2026-07-28 — Audit open-interest persistence and refine daily charts

User request:

- Confirm that open interest is stored in SQLite and fetched from SQLite rather than rendered directly from a provider response.
- Invert the open-interest graph vertically so upward values display downward and downward values display upward.
- Make the 0700, 9988, and 0005 cards small daily charts instead of weekly charts.

Implementation:

- Audited the live database and confirmed 169 distinct daily open-interest rows in `hsi_open_interest`, spanning 2025-11-17 through 2026-07-28, with both HKEX and Futu sources.
- Kept provider ingestion save-first and made the graph consume only the complete SQL-backed `/api/hkex/open-interest` history, removing the client-side live-snapshot graph bypass.
- Enabled the inverted price scale on the open-interest pane without changing stored values.
- Kept 0700, 9988, and 0005 on the enforced `1d` candle endpoint, made each compact card show the latest 30 daily sessions, and labeled them explicitly as daily bars.

### 2026-07-28 — Refresh open interest with the live data cycle

User request:

- Fix open interest not refreshing when the other market data refreshes.

Implementation:

- Traced the stale graph to the five-second Futu poll persisting its open-interest snapshot into SQLite without triggering the chart's separate SQL history read.
- Made every verified five-second Futu snapshot response trigger an immediate reload of the SQL-backed open-interest history.
- Preserved the save-first invariant: the live provider response is persisted by the API before the client rereads SQLite, and provider data is never applied directly to the graph.

### 2026-07-29 — Keep open-interest metrics comparable across contract rolls

User request:

- Fix the open-interest chart because its latest movement and value did not make sense.

Implementation:

- Traced the false discontinuity to one line mixing HKEX all-contract totals with Futu `HK.HSImain` main-contract snapshots, whose value changes materially when Futu rolls the selected contract month.
- Stopped the five-second Futu pipeline from replaying its rolling JSON history into SQLite and overwriting completed HKEX report dates.
- Made HKEX daily reports authoritative on date conflicts, repaired contaminated dates from the official cache, and made the history refresh refetch dates whose stored source is not yet authoritative.
- Prevented the HKEX cache writer from relabeling or copying Futu observations into the official history mirror.
- Kept the inverted purple chart as the comparable HKEX all-contract-total series and displayed the current Futu main-contract observation separately in amber, with its date, instead of connecting the two metrics into a misleading line.
- Verified 170 SQLite rows after repair, including the official July 24 total of 147,792 and July 28 total of 136,311, with July 29's Futu main-contract value of 62,527 kept separate.
- Observed a complete five-second dashboard refresh with no browser errors and confirmed by a guarded overwrite test that a Futu refresh cannot replace a completed HKEX row.

### 2026-07-29 — Establish real-data source contracts and reusable auditing

User request:

- Investigate why market data is repeatedly wrong by checking the README and code.
- Use real data, build reusable skills around data correctness, and record the findings.

Implementation:

- Audited the provider-to-chart paths and found systemic source/cadence problems: the Futu-labelled page preferred a competing Tencent HSI quote, automatic refresh forced full Futu history every five seconds, daily Yahoo charts were force-fetched every five seconds, and CITIC daily data was eligible for five-second provider refetches.
- Made Futu OpenD `HK.800000` the sole live price/OHLC source on the Futu page and added provider-timestamp freshness validation before a snapshot may update the badge, candle, or knockout range.
- Limited automatic Futu full-history refreshes to the server cache cadence while keeping live snapshots on the required five-second poll; manual **Refresh All Data** can still force a full refresh.
- Changed related daily charts to reread their 15-minute server cache rather than force-fetching Yahoo on every five-second UI event.
- Throttled CITIC daily provider refetches to five minutes while retaining five-second SQLite rereads and last-verified-data behavior.
- Fixed the invalid exported helper in the Next.js market-chart route that prevented production route type validation.
- Renamed the page from “Futu test” to “Futu verified” and expanded provider definitions so cash, rolling futures volume, live main-contract position, official all-contract OI, and CBBC scope are explicit.
- Created and validated the project skill at `skills/audit-real-market-data/`, including a durable metric contract and deterministic SQLite/Futu-cache audit script; linked it from `AGENTS.md` and exposed it as `npm run audit:market-data`.
- The audit passed with zero errors and warnings: 169 official HKEX OI rows through 2026-07-28, one separate Futu main-contract row for 2026-07-29, 153 long and 54 short money-flow rows through 2026-07-28, current CBBC publication metadata, and current Futu `HK.800000`/`HK.HSImain` snapshots.

### 2026-07-29 — Add the provider-backed HSI expiry countdown

User request:

- Add a progress bar in the Market Data header showing the number of days before HSI futures expiry, using a 30-to-0 scale.
- Show `0` and make the indicator red when today is the expiry date.

Implementation:

- Resolved Futu `HK.HSImain` to its exact current monthly `origin_code`, then read that contract's provider-reported `last_trade_time` instead of guessing expiry from a calendar rule.
- Added the contract code, expiry date, source, and definition to the persisted full Futu market-data payload.
- Added a compact header progress indicator that calculates Hong Kong calendar days, uses a 30-day scale, warns in amber inside seven days, and turns fully red at `0`.
- Added exact-contract expiry validation to the reusable market-data audit and documented the source invariant in the project and skill data contracts.

### 2026-07-29 — Compact and invert the expiry progress header

User request:

- Remove the empty vertical space introduced by the expiry component and arrange the header like the supplied third reference image.
- Invert the progress meaning so yellow represents days already passed and the right side represents the `期結` goal.

Implementation:

- Moved the page title, Daily/live status, expiry progress, and action buttons into one responsive header owned by `HsiPanel`, eliminating the duplicated outer header row.
- Kept the title and live badges grouped on the left, centered the expiry progress, and grouped refresh/alert actions on the right at wide dashboard sizes.
- Changed progress from “days remaining fill” to “elapsed days fill”: at one day remaining, 29 of the 30 days are yellow, and `期結` is visibly marked at the right end.
- Preserved the provider-backed countdown value and full red expiry-day state.

### 2026-07-29 — Restore normal open-interest orientation

User request:

- Invert the open-interest chart back to its normal orientation.

Implementation:

- Disabled the inverted price scale on the official HKEX all-contract-total open-interest pane, so larger totals now plot higher and smaller totals plot lower.
- Removed the obsolete “inverted axis” legend text.
- Preserved the SQLite-backed HKEX history and separately displayed Futu main-contract observation without changing stored values or source precedence.

### 2026-07-29 — Swap expiry progress colors

User request:

- Invert the yellow and gray colors in the `期結` progress bar.

Implementation:

- Kept the elapsed/remaining calculation unchanged while switching elapsed days on the left to gray.
- Made the remaining distance on the right yellow so it visually leads into the `期結` goal.
- Preserved the fully red 0-day expiry state.

### 2026-07-29 — Neaten and stabilize the market-data header

User request:

- Fix the awkward expiry/header layout and place the controls neatly.

Implementation:

- Rebalanced the wide-screen header columns so the title/status group, centered expiry card, and right-side actions each have predictable space.
- Capped and centered the expiry card instead of allowing it to stretch disproportionately.
- Made all action buttons fixed-height, non-shrinking, and single-line; the KO Alert control can no longer wrap into a tall two-line button.
- Preserved the responsive stacked layout at narrower viewport widths.

### 2026-07-29 — Align title and live status in the header

User request:

- Correct the remaining slight displacement of the Daily/live controls.

Implementation:

- Moved the page title, Daily selector, and live-price badge onto the same vertically centered line at wide dashboard sizes.
- Widened the left header zone to fit the complete group without wrapping and slightly reduced the centered expiry-card cap to preserve balanced spacing.
- Kept the narrow-screen responsive stacking and all market-data behavior unchanged.

### 2026-07-30 — Keep the expiring HSI contract through expiry day

User request:

- When today is HSI futures expiry, show that it expires today instead of displaying the next month's countdown.
- Replace the rollover logic completely and record the new rule in the project and market-data skill Markdown files.

Diagnosis:

- On the July 2026 final trading date, Futu had already rolled `HK.HSImain.origin_code` to `HK.HSI2608`, so the old display truthfully calculated 29 days to August but answered the wrong product question. The expiry header must represent the front calendar contract, not whichever month currently has main-contract liquidity.

Implementation:

- Stopped using `HK.HSImain.origin_code` for the expiry display because Futu can roll that liquidity-selected symbol to the next month before the current contract's final trading day has ended.
- Query the exact current and next calendar-month HSI contracts from Futu and select the first contract whose provider `last_trade_time` has not passed in Hong Kong calendar time.
- Keep the current-month contract on its final trading date, show `今天期結` in the red expiry state, and roll to the next month only on the following HKT date.
- Invalidate legacy cached expiry metadata that lacks the new selection policy so a restart cannot briefly promote an old early-roll contract as the current expiry display.
- Added deterministic selection tests and expanded the reusable market-data audit and data contract to enforce the front-calendar-month policy.
- Verified four deterministic expiry-selection tests, including expiry-day retention, next-day rollover, year rollover, and invalid provider-date rejection.
- Verified the live Futu response and persisted app cache at `2026-07-30` resolve `HK.HSI2607` with `last_trade_time=2026-07-30` and `daysToExpiry=0`.
- Observed the running Market Data UI before and after a complete five-second refresh: it remained red, showed `今天期結` and `HSI2607 · 2026-07-30`, and produced no browser console errors.
- The market-data audit passed with zero errors: 170 official HKEX open-interest rows through 2026-07-29, one separate Futu main-contract row for 2026-07-30, 154 long and 55 short money-flow rows through 2026-07-29, and one expected warning for the prior J.P. Morgan CBBC publication date.

### 2026-08-24 — Stabilize right-side Futu stock cards

User request:

- Fix the 0700, 9988, and 0005 right-side charts because their prices and percentages reload to conflicting values every five seconds.

Diagnosis:

- The daily Yahoo history reread and the Futu snapshot event both replaced the same candle array. The header percentage was derived from whichever asynchronous response rendered last, so all three cards alternated between the prior Yahoo close and the verified Futu quote.

Implementation:

- Added Futu `prev_close_price` to the normalized snapshot contract for `HK.00700`, `HK.09988`, and `HK.00005`, and derive percent change only from that field and the same snapshot's `last_price`.
- Kept the latest verified Futu quote in dedicated state and a synchronous ref, rejected older provider timestamps, and re-merged that quote after every Yahoo history reread so neither the header nor current chart bar can revert.
- Made the card header use the provider's price, previous close, and percent change directly; Yahoo remains the 30-session chart-history source only.
- On a fresh load, show a placeholder until the first verified Futu tuple arrives instead of briefly exposing a Yahoo-derived header value.
- Added audit enforcement for all three snapshot tuples and prevented historical Futu main-contract open-interest observations from remaining inside the authoritative HKEX date range.
- Verified the live normalized Futu tuples: 0700 `440 / 457 / -3.72%`, 9988 `112.5 / 123 / -8.54%`, and 0005 `161.5 / 162.9 / -0.86%` (price / previous close / derived percent).
- Observed 18 consecutive rendered samples over more than three five-second refresh cycles; all three cards had exactly one stable state and the browser reported no warnings or errors.
- The deterministic market-data audit passed with zero errors (two expected overnight/provider-publication warnings), targeted lint passed, and the complete Next.js production build passed with webpack under the pinned Node 22.23.0 runtime.

### 2026-09-08 — Add a centred 15-minute HSI and CBBC view

User request:

- Add a 15-minute button beside Daily and before the stale/refresh badge, opening a centred, non-fullscreen HSI chart with CBBC overlays; clicking the shaded area outside closes it.

Implementation:

- Added an independent 72vw × 76vh chart dialog with native Futu HK.800000 15-minute cash candles and the existing five-second Futu CBBC recovery-level payload. Daily remains mounted with its existing data workflows and viewport.
- Added outside-click, close-button, and Escape dismissal, focus restoration, and background scroll locking. Chart timestamps are explicitly Hong Kong time; CBBC labels show side and outstanding street volume in millions.
- Added a separate intraday API/Python bridge because the existing backtest endpoint supplies HK.HSImain futures, which must not replace the cash index. Provider history is cached for 60 seconds, persisted atomically in data/futu_hsi_intraday.json, and reread every five seconds while open. Failed requests preserve verified candles with a stale/unavailable message.
- Verified 220 persisted, unique provider bars with valid OHLC and native 15-minute timestamps. No daily SQLite histories were changed by this implementation.
- TypeScript and targeted ESLint passed. The market-data audit passed with zero errors: 198 official OI rows, one separate Futu position row, 182 long-flow rows and 83 short-flow rows. Two legitimate warnings remain: pre-open Futu cash timestamp and older J.P. Morgan publication.
- Observed the chart and CBBC overlays across multiple five-second cycles with advancing background quote timestamps; verified outside-click dismissal, reopening, Escape dismissal and restored button focus. Browser warning/error log was empty.

### 2026-09-08 — Expand the intraday view and use HSI futures

User request:

- Remove magnetic snapping, provide at least 850 bars, and use futures prices instead of spot in the 15-minute view.

Implementation and verification:

- Set the dialog crosshair to CrosshairMode.Normal for free movement. Switched native K_15M candles to Futu HK.HSImain rolling main-contract futures and expanded paginated history to 90 days. Reject responses and saved caches with the wrong symbol/interval or fewer than 850 bars.
- Isolated futures persistence in data/futu_hsi_futures_intraday.json so old cash candles cannot appear as futures, including on failures. Preserved the 60-second provider cache, five-second reread and existing daily chart workflows.
- Added loaded-bar count and futures identity to the header. CBBC overlays remain unadjusted cash-index recovery prices, visibly labelled with the futures-basis distinction; no fabricated basis adjustment or futures-based knockout calculation was introduced.
- Verified 4,017 unique persisted futures bars with valid OHLC. Observed the rendered futures chart across five-second refreshes and confirmed the crosshair follows a clicked price away from candles rather than snapping to their close.
- TypeScript and targeted ESLint passed. Market-data audit passed with zero errors; existing pre-open cash timestamp and older J.P. Morgan publication warnings remain. Daily persistence retained 198 official OI rows, one separate Futu position row, 182 long and 83 short money-flow rows.

### 2026-09-08 — Correct CBBC placement on the futures price scale

User request:

- Fix incorrectly priced CBBC lines in the 15-minute futures dialog.

Diagnosis and implementation:

- The earlier futures switch left cash recovery levels plotted directly on the futures axis. Translate each display line by the futures-minus-cash basis from the latest matching completed Futu K_15M timestamp. Original provider recovery levels and daily behavior remain intact.
- Persist the matched cash/futures closes, symbols, timestamp, source and computed basis with the futures candles. Reject old caches without basis metadata; hide overlays if a matched basis is unavailable. Never combine overnight/current futures and previous-session cash snapshots.
- Label the original cash recovery price on each line and describe axis placements as estimated futures levels, not knockout triggers. Display the basis timestamp and stale-reference state.
- Verified the persisted 2026-09-07 16:00 HKT pair: futures 25,366, cash 25,413.12, basis -47.12. Cash recovery 25,350 therefore plots at estimated futures 25,302.88. This prior-session basis is explicitly stale before today's cash session starts.
- Four deterministic tests passed for discount direction, premium direction, mismatched timestamps, and incomplete/invalid observations. TypeScript and targeted ESLint passed. Market-data audit passed with zero errors and the existing pre-open Futu cash/older J.P. Morgan publication warnings.
- Confirmed the adjusted CBBC price labels in the running dialog across five-second refresh cycles. Persisted futures history retains 4,017 bars; daily SQLite counts remain 198 official OI, one Futu position, 182 long-flow and 83 short-flow rows.

### 2026-09-08 — Return the 15-minute chart to HSI spot

User request:

- Use HSI spot in the 15-minute graph after confirming CBBC knockout levels refer to spot.

Implementation and verification:

- Switched the paginated 90-day native K_15M feed and client/API source validation to Futu HK.800000. Restored the separate spot cache with the minimum 850-bar check; futures caches cannot be used as spot fallback.
- Removed the basis calculation from the active fetch/render path and plotted actual CBBC recovery prices directly. Updated titles and source contracts to HSI Spot. Preserved the free crosshair, centred dismissible view, five-second rereads, 60-second provider cache and daily workflows.
- Verified 1,364 unique persisted spot candles with valid OHLC and no basis metadata. Observed the spot chart and actual CBBC axis prices across refresh cycles in the running UI.
- TypeScript, targeted ESLint and market-data audit passed. Audit retained 198 official OI rows, one Futu position, 182 long-flow and 83 short-flow rows; the older J.P. Morgan publication and pre-open Futu cash-cache warnings remain disclosed.

### 2026-09-15 — Correct 15-minute bull and bear CBBC totals

User request:

- Fix the incorrect bull and bear warrant levels shown in the 15-minute HSI dialog.

Diagnosis:

- Futu reported 2,930 NORMAL-status HSI CBBC products, but the bridge read only the first 200 products sorted by individual street volume and then grouped that partial page by recovery price. The recovery prices were real, but both bull and bear outstanding totals omitted lower-ranked products at the same price.

Implementation and verification:

- Paginate the complete Futu CBBC universe in stable product-code order, deduplicate by product code, and reject any snapshot whose fetched row count does not equal the provider `all_count`.
- Aggregate every verified product by exact recovery price and publish completeness metadata. The API keeps this slower complete-universe refresh separate from the five-second cash/futures snapshot so live quotes do not stall, and preserves the last complete warrant snapshot during an in-flight refresh or provider failure.
- Limit the 15-minute overlay to valid bull levels below spot and bear levels above spot within 1,800 index points, ranked by complete outstanding street volume.
- Added a deterministic market-data audit error for partial Futu CBBC pagination and documented the complete-universe contract.
- Verified a complete live fetch of 2,930/2,930 products across 1,111 recovery levels. Corrected examples include Bull 24,500 from 102.145M to 155.317M, Bear 25,500 from 73.260M to 114.720M, Bear 25,400 from 118.060M to 145.842M, and Bear 25,403 from 81.330M to 97.730M.
- Observed the corrected labels in the running 15-minute dialog across a five-second refresh cycle with no browser warnings or errors. Pinned-Node TypeScript and targeted lint passed. The market-data audit passed with zero errors, 204 official OI rows, one separate Futu position row, 188 long-flow rows and 89 short-flow rows; the two remaining warnings are the expected prior-session cash timestamp and older J.P. Morgan publication.

### 2026-09-20 — General/Detail CBBC presentation on Main Data

User request:

- Add a selection control on the Main Data page so the chart can show Backup Data’s CBBC calculation or the Futu recovery-price calculation.
- Default to General (Backup Data 100-point bands). Detail is the existing Futu exact recovery overlay.
- Keep KO alerts and real-time data for both presentations. Always keep money flow and open interest visible.

Implementation:

- Replaced the inert Daily pill on the Futu Market Data header with a General / Detail tab bar.
- General overlays `/api/cbbc/latest` 100-point outstanding bands and evaluates knockouts against the live Futu cash high/low.
- Detail keeps the complete Futu recovery-price overlay, session-level registry, and 15-minute exact-level dialog.
- The five-second Futu live poll still updates price, volume, and SQLite-backed open interest regardless of the CBBC tab.
- Switching tabs clears the previous warrant lines and reseeds the KO baseline so mixed methods cannot remain on the same axis.
- Verified on the running Market Data page: General is selected by default and draws 100-point bands (bucket width 99); Detail draws 18 exact Futu recovery prices (bucket width 0). Money flow, HKEX open interest, live badge, and KO Alert remained visible in both modes. Backup Data still uses its existing CBBC panel without this tab. Market-data audit passed with zero errors and one expected Futu-cache-stale warning.

### 2026-09-20 — Reorder the product tab bar

User request:

- Rearrange the tab bar to Main Data > Backtest > Chart > Backup.

Implementation:

### 2026-09-20 — Refresh delayed backtest candles on app open

User request:

- Rebuild the backtest machine because its data is delayed.
- Refresh backtest candles every time the app opens.
- Add a button to refresh that data.

Diagnosis:

- `GET /api/backtest/candles` returned any stored SQLite range immediately and never called Futu OpenD again. `data/backtest.sqlite` last bars were frozen at 2026-07-13 for `1m`/`15m`/`4h`/`1d`.

Implementation:

- Added `POST /api/backtest/refresh`, which fetches the latest Futu `HK.HSImain` tail, upserts into SQLite, and preserves older bars.
- App open now starts that refresh for all four timeframes. The Backtest page refreshes the selected timeframe on load and exposes **Refresh data**.
- Candle reads mark stale history when the last bar is behind the expected Hong Kong session, and a failed OpenD call keeps the last verified SQL candles.

Verification:

- Stored history had been frozen at 2026-07-13. After refresh, SQLite coverage is `1m` 1,926,543 bars through `2026-09-21 10:17`, `15m` 128,789 through `2026-09-21 10:15`, `4h` 9,288 through `2026-09-19 03:00` (Futu 240-minute night-session stamp), `1d` 4,914 through `2026-09-21`.
- Live `POST /api/backtest/refresh` for 15m returned `ok: true` with last bar `2026-09-21 10:15:00`.
- Observed the Backtest page: **Refresh data** appears, open-load status showed `History ready · last 2026-09-21 10:15:00`, chart range `2018-07-09 → 2026-09-21`, and a second refresh completed without losing stored history.
- Main Data still showed LIVE Futu cash around 24,878 with a five-second countdown and HKEX open interest after the layout-level backtest sync.
- `npm run audit:market-data` passed with zero errors and zero warnings.

### 2026-09-20 — Hide Backup Data from the tab bar

User request:

- Hide the Backup Data option in the tab bar.

Implementation:

- Removed Backup Data from `TopTabs`. The `/` page and its CBBC/case workflows remain reachable by URL so the existing pipeline is not deleted.
- Verified the header shows Main Data, Backtest, and Chart Data only. `http://localhost:3000/` still loads the backup dashboard.

### 2026-09-21 — Auto strategy panel on Backtest

User request:

- Auto-backtest strategies for the nearest 5–20 trading days, with that lookback customizable.
- Daily top/bottom: when they appear, as a time range.
- Recent volatility for those days.
- Opening-range 09:15–09:29 breakout: average follow-through points.
- Opening-range false breakout (skip the first side, take the other side): average follow-through, default RR 1:2.
- Show the results in a panel.

Implementation:

- Added Backtest views: Auto strategies (default) and the existing Python strategy machine.
- Auto strategies read stored Futu `HK.HSImain` 1-minute candles from `data/backtest.sqlite` for the HSI futures day session (09:15–12:00 and 13:00–16:30 HKT). Opening range uses candle end times 09:16–09:30, which cover 09:15–09:29.
- `GET /api/backtest/auto` runs four studies: first print of the session high/low with a 25th–75th percentile window, high–low and 1-minute true-range volatility, first opening-range break max follow-through, and false-break opposite-side trades with customizable RR (default 1:2). Incomplete opening ranges are excluded. Older stored bars are never deleted.
- Lookback is selectable 5–20 complete sessions. Changing lookback or RR reruns automatically.

Verification:

- `node scripts/test_auto_strategies.js` passed. Live `GET /api/backtest/auto?days=10` used closed day sessions 2026-09-07 through 2026-09-18 and skipped the incomplete 2026-09-21 session.
- Day-session high window 09:25–13:35 (median 09:56); low window 09:25–09:47 (median 09:36). Observed Auto strategies and Python strategy tabs on the running Backtest page. Market-data audit passed with zero errors and zero warnings.

### 2026-09-21 — Fix MacdBacktest parse error

User request:

- Fix the Backtest build error: Parsing ecmascript source code failed, `'const' declarations must be initialized` at the history `useEffect` dependency array.

Implementation:

- Closed the `if (refreshNonce > 0)` refresh block so candle history loading stays in the same `load` function with initialized `let end`. The parser no longer treats the following `useEffect` as an uninitialized `const`.

### 2026-09-21 — Make Auto backtest charts readable

User request:

- Make Auto strategies understandable: graphs on top, explain volatility and green/red dots, larger fonts, drop the confusing extreme-points chart, and show opening-range first-break vs false-break max points.

Implementation:

- Rebuilt the Auto backtest panel with charts first. The top chart is grouped bars: blue = max points after the first 09:15–09:29 break, purple = max points after a false break the other way.
- Volatility is a labeled bar chart of 09:15–16:30 high–low. High/low timing is one row per day with green = high and red = low. The 30-minute histogram was removed. Titles, legends, and the day table use larger type.

### 2026-09-21 — Mark 9:30 on the high/low time chart

User request:

- The high/low print chart should also show where the 9:30 line is.

Implementation:

- Drew an orange dashed vertical at 9:30 (end of the 09:15–09:29 opening range) with a 9:30 axis label.

### 2026-09-21 — Day-session high and low only

User request:

- Count relative high and low during HSI open hours only, not the night market, because 18’s low was showing before 9:30.

Implementation:

- High/low timing now uses the 09:15–16:30 day session only. Night futures no longer set the green/red dots or the usual-time summary. The time chart x-axis is 09:15 to 16:30 with the 9:30 opening-range line.

### 2026-09-21 — Wrap high/low panel including night

User request:

- Add another high/low panel that also counts the night market.

Implementation:

- Kept the day-session high/low chart. Added a second panel for the full futures wrap (17:15–03:00 night plus 09:15–16:30 day), with green wrap high, red wrap low, and the 9:30 line. The day-by-day table now has Day high/low and Wrap high/low columns.

### 2026-09-21 — Three chart boxes in one row

User request:

- Place the night high/low panel next to the day high/low chart, three boxes in a row.

Implementation:

- Put volatility, day high/low, and wrap high/low in one three-column row.

### 2026-09-21 — Start wrap high/low axis at 9:15

User request:

- The including-night high/low chart should still wrap, like the day-only chart, with the 9:15 line close to the start.

Implementation:

- Reordered the wrap time axis to start at 9:15, run through the day to 16:30, then wrap the night session to 03:00 on the right. The 9:30 opening-range line sits just after 9:15.

### 2026-09-21 — Align wrap high/low with day-only chart

User request:

- The including-night high/low chart was a bit misaligned: 9:15 and 9:30 labels collided, and the 9:30 line sat on top of 9:15 compared with the day-only chart.

Implementation:

- The wrap chart now uses the same size and padding as the day-only high/low chart. Day hours (09:15–16:30) take most of the x-axis with the same clock ticks as the middle panel; night wraps into the remaining band on the right. 9:30 stays as the orange dashed line only, so it no longer overlaps 9:15.

### 2026-09-20 — Place Python code above statistics

User request:

- The Python code panel should be on top of the statistics.

Implementation:

- Reordered the Backtest right-hand column so the Python Code editor is above the Statistics table. Chart, equity curve, run controls, and data workflows were left unchanged.

### 2026-09-21 — Auto strategy graphs and session scopes

User request:

- Volatility should count 09:15 to market close.
- Top/bottom should also count night futures (all hours).
- Add a graph view for auto strategy backtest because the numbers were unreadable.

Implementation:

- Volatility high–low and 1-minute true range now use only the HSI futures day session, 09:15–12:00 and 13:00–16:30 HKT.
- Daily top/bottom first-print times use the full wrap: previous night 17:15–03:00 plus that day's session. Weekend night bars attach to the next weekday. Labels mark `n` night vs `d` day.
- Auto strategies now render four graphs: day-session range by date, top/bottom print times on a night-then-day axis, a 30-minute histogram of those times, and opening-range follow-through points.
- Opening-range breakout and false-break studies remain on the day session. Stored 1-minute history is not deleted.

Verification:

- `node scripts/test_auto_strategies.js` passed, including a night-high case where Monday's top is `21:00 n` while the day-session range ignores that night extreme.
- On stored 2026-09-14–18 1m bars, day-session ranges stayed smaller than all-hours ranges (e.g. 2026-09-17 280 vs 388). Tops included `19:01 n` / `22:10 n`.
- Observed the Auto strategies panel graphs and `n`/`d` time labels on the running Backtest page.

### 2026-09-21 — Python strategy session count instead of date pickers

User request:

- Replace the Python strategy start/end date selectors with a number. Typing 10 should backtest 10 sessions.

Implementation:

- Removed the calendar start/end fields and All dates. The Python strategy now takes a session count (default 15).
- The last N completed HSI futures day sessions are selected, including attached night bars, through the last closed Hong Kong session. The resolved range is shown next to the field.
- `/api/backtest/run` accepts `sessions` and reads those session dates from `data/backtest.sqlite`.

Verification:

- On the Python strategy page the date pickers are gone. Default 15 sessions resolved to 2026-08-31 → 2026-09-18. Typing 10 showed `10 sessions · 2026-09-07 → 2026-09-18` and the 1m chart included the attached Friday night bars.



### 2026-09-20 — Python strategy default window and USD capital

User request:

- Python strategies should automatically choose 1 minute and 15 days by default.
- Starting capital is 50,000 USD.

Implementation:

- Python strategy now opens on the 1-minute chart with a 15-calendar-day date range ending at the latest stored HK.HSImain bar.
- Starting capital defaults to USD 50,000. The engine still accounts HSI futures at HK$50 per point after converting capital at the verified USD/HKD quote, with a 7.8 fallback if that quote is unavailable. Statistics and the equity curve display USD.

### 2026-09-20 — Stop backtest from polling today

User request:

- In the backtest, today's data is not needed. It just keeps refreshing.

Implementation:

- Backtest history now ends at the last completed Hong Kong session. Today's in-progress session is not fetched and is not treated as missing.
- App open and chart load reread SQLite and call OpenD only if that closed session is absent. **Refresh data** can still refetch the closed tail. Auto strategies also exclude today.
- Older stored bars remain. The market-data contract and audit treat closed-session coverage as sufficient.

### 2026-09-21 — Alert when a General CBBC band knocks out

User request:

- The CBBC General panel does not alert when a CBBC knocks out. Make the knockout alert work.

Diagnosis:

- General bands are 100-point outstanding buckets. The alert and the gray KO state waited until cash had passed the far side of the bucket (bear `end + 1`, bull `start - 1`). Warrants inside the bucket knock out as soon as cash reaches the near edge.
- The outstanding feed removes a bucket when it knocks out. General mode only tested buckets still present in the latest response, so a bucket that disappeared on the knockout poll never produced an alert. Detail mode already kept a session registry.

Implementation:

- General alerts and gray KO state now use the near edge: bear bands when the live cash high reaches the band start, bull bands when the live cash low reaches the band end. The drawn line stays on the far boundary.
- Bands seen this session stay in memory and in date-scoped browser storage after they leave the outstanding feed, so the knockout is still evaluated. A failed outstanding read keeps the last registry. The first poll after open, a new session, or a General/Detail switch only records the baseline.
- Detail alerts stay on the exact Futu recovery price.

Verification:

- `scripts/test_cbbc_knockout.ts` passed: band entry alerts, far-side-only crosses are no longer required, a dropped bucket still alerts once, a repeated poll does not alert again, and exact detail prices are unchanged.
- On the running Main Data page, General was selected with KO Alert on. All 28 labels were 100-point bands. Bear triggers equalled the band start and bull triggers equalled the band end. With live Futu cash high 25,219.61, bear bands 25,000, 25,100, and 25,200 were marked KO; the next bear band was not. The nearest bull band 24,700–24,799 stayed active because the session low 25,044.29 had not reached 24,799. The Test button showed the knockout toast. Detail showed 18 exact recovery prices with trigger equal to the line. Switching back to General and waiting through a five-second refresh kept the same trigger rule, the live badge, and money flow, with no load error.
- `npm run audit:market-data` passed with zero errors and zero warnings: 208 official OI rows, 1 Futu position row, 192 long-flow rows, 93 short-flow rows.

### 2026-09-21 — Knock out a General band only when its line is printed

User request:

- The CBBC knockout state is wrong. The 404 band is marked knocked out even though price never hit it.

Diagnosis:

- The previous change treated a 100-point band as knocked out when cash entered the bucket. The 404 label is the bear band 25,200–25,299, drawn at 25,300. The session high of 25,219.61 traded inside that bucket and never printed 25,300, so the gray KO mark was false.

Implementation:

- General knockout state and alerts now use the drawn line only: bear bands at `end + 1`, bull bands at `start - 1`. Entering the bucket is not a knockout. Detail remains the exact recovery price.
- A band that leaves the outstanding feed is still tracked, so an alert still fires when cash later prints that line. Levels already knocked out when the page opens stay in the baseline and do not alert again.

Verification:

- The knockout checks cover the 404 band: high 25,219.61 does not knock out the 25,300 line, and high 25,300 does. A dropped band still alerts once when its line is crossed, and a repeated poll does not alert again.
- Reloaded Main Data on General. The 404 label is active, with its line and trigger both at 25,300. KO remains on 383 at 25,200 and 312 at 25,100, both at or below the live high of 25,219.61. Every visible label's trigger matches its drawn line.

### 2026-09-21 — Keep the live HSI price moving while CBBC bands refresh

User request:

- The price stopped moving and updating.

Diagnosis:

- The five-second cash tick was waiting in the same request as the CBBC outstanding read. A slow or stuck band refresh held that tick, so the badge and today's candle stayed on the last price.

Implementation:

- The Futu cash snapshot now updates the badge and today's candle on its own request, with a four-second timeout so a hung call cannot block the next tick. The outstanding-band read runs separately and can no longer stop the price.
- Knockout checks still run on each cash tick against the bands already on the chart. 404 remains active unless cash prints its 25,300 line.

Verification:

- Reloaded Main Data. The live badge moved 25,185.69 → 25,181.99 → 25,175.73 across two refresh cycles. The live requests finished in under a second. The 404 label stayed active at 25,300.

### 2026-09-21 — Grey General bands the session high has already traded through

User request:

- Two CBBC bands that should already be knocked out are not grey.

Diagnosis:

- 383 is the bear line at 25,200 and 312 is the bear line at 25,100. Today's Futu cash high is 25,254.11, so both lines are already traded through. 404 stays active because its line is 25,300.
- The grey state only looked at the latest live-tick high. When that tick had not landed, the chart candle already showed the session high but the bands stayed red.

Implementation:

- The session high and low now widen from both the live tick and today's candle, and they are not replaced by a later narrower value. Knockout color and alerts use that range, so a band turns grey when the candle high or low has already reached its line.

Verification:

- On General, 383 is grey at 25,200 and the bear 312 is grey at 25,100. 404 remains red at 25,300. The bull 312 at 24,499 stays green because the session low 25,044.29 has not reached it.

### 2026-10-01 — Session clocks on the night high/low chart

User request:

- On the high-and-low chart that includes the night session, draw when the market closes and when the Europe and US markets open, including the summer/winter clock change.

Implementation:

- The wrap chart (9:15 through 03:00) now draws three reference lines from each session date. Grey is the Hong Kong cash close at 16:00, which does not change with daylight saving. Blue is the Europe cash open (London 08:00, the same instant as Frankfurt 09:00): 15:00 HKT in summer and 16:00 HKT in winter. Purple is the New York cash open at 09:30: 21:30 HKT in summer and 22:30 HKT in winter.
- Summer follows the civil rules: Europe after the last Sunday of March until the last Sunday of October, and the US after the second Sunday of March until the first Sunday of November. A lookback that crosses a change steps that line instead of keeping one clock for every row.
- The night chart uses the full row so those labels stay readable.

Verification:

- September 2026 dates are summer for both clocks: Europe open lands at 15:00 HKT and the US open at 21:30 HKT. Checked the Auto strategies page: the grey close, blue Europe open, and purple US open are drawn on the wrap chart for 09/17–09/30, with the orange 9:30 line and the green and red wraps still in place.
- Clock checks for the season gaps: 2026-03-20 is Europe winter 16:00 and US summer 21:30; 2026-10-26 is Europe winter 16:00 and US summer 21:30; 2026-01-15 and 2026-11-02 are both winter (Europe 16:00, US 22:30).

### 2026-10-05 — Use red for highs and green for lows

User request:

- Correct the Auto strategies high/low charts so highs are red and lows are green.

Implementation:

- Swapped the high and low dot colors in both the day-only and including-night charts: red now represents highs and green represents lows.
- Updated both chart descriptions to match the corrected color meaning without changing the high/low calculations, session scopes, or timing markers.

### 2026-10-05 — Typed Auto lookback and 10:30 chart line

User request:

- Add a 10:30 reference line to the high/low charts.
- Replace the fixed backtest-date selection with a typing box and enlarge long high/low charts.

Implementation:

- Added a teal dashed 10:30 reference line and label to both the day-only and including-night high/low charts while preserving the orange 9:30 marker.
- Replaced the 5–20 date dropdown with a debounced numeric input accepting 1–120 completed HSI futures trading dates, and applied the same validated range in the API and strategy engine.
- Made both row-based high/low charts grow vertically with the returned date count so longer lookbacks retain readable spacing.

Verification:

- Typed 30 dates in the running Auto strategies page and confirmed 30 completed sessions rendered, both charts included 10:30, and their SVG heights expanded to 740 and 752 view-box units.
- Typed 60 dates and confirmed 60 table rows rendered while the day-only and including-night charts expanded to 1,400 and 1,412 view-box units.
- Targeted lint and the Auto strategy test passed. The market-data audit passed with zero errors, 216 official HKEX open-interest rows, one separate Futu position row, 200 long-flow rows, and 101 short-flow rows; the two warnings were existing CBBC publication/Futu cash-cache freshness notices.

### 2026-10-05 — Compact Auto strategy dashboard

User request:

- Keep long-lookback charts compact instead of stretching the entire time map and forcing excessive page scrolling.
- Improve the Auto strategy UI shown in the supplied screenshots.

Implementation:

- Returned both high/low time maps to fixed compact heights. Large lookbacks now use smaller dots and sampled date/grid labels while every session remains plotted and exposes its exact date/time on hover.
- Prevented opening-range and volatility bars, value labels, and date labels from overlapping at long lookbacks by narrowing bars, sampling dates, and moving dense values into hover titles.
- Reorganized the four charts into a two-by-two desktop dashboard and shortened the explanatory copy.
- Collapsed the day-by-day table by default behind one expandable summary row, eliminating the table's page-length cost until the user asks for detail.

Verification:

- Ran the live page with 120 requested dates (111 complete sessions available). Both time maps remained 256 CSS pixels high while retaining 222 day-session dots and 215 wrap-session dots; each map showed only 12 sampled date labels.
- Confirmed the four cards render as two equal-height desktop rows, the 111-row detail table stays closed by default, and the browser reported no warnings or errors.
- Targeted lint and Auto strategy tests passed. The market-data audit passed with zero errors; its two warnings were the existing CBBC publication and Futu cash-cache freshness notices.

### 2026-10-05 — Code-only Python configuration and Auto EMAs

User request:

- Remove manual Python backtest configuration controls and put timeframe, sessions, capital, costs, risk, execution, and same-bar policy in the Python code.
- Update the copied AI prompt so AI-generated strategies include all configuration parameters.
- Improve the remaining control placement and add EMA average lines with point values to opening-range and volatility charts.

Implementation:

- Added a required top-level literal `BACKTEST` dictionary to the default Python source and made the server extract and validate it before selecting stored candles. The runner uses that code configuration for engine settings and converts `starting_capital_usd` with the runtime USD/HKD quote.
- Removed the timeframe buttons and the sessions/capital/spread/risk/execution/same-bar toolbar. The header now displays a compact read-only summary derived from the Python code.
- Rewrote **Copy AI Prompt** to require the complete `BACKTEST` dictionary, document every supported value, and return a single paste-ready code block containing configuration plus `strategy(bars)`.
- Added rolling EMA lines over up to five displayed sessions to first-break, false-break, and day-range series, with the latest EMA point values printed on the charts.
- Aligned the Auto strategy Days, False-break, Run, and status controls in one compact row.

Verification:

- Confirmed the live Python page contains no timeframe buttons or manual configuration fields and displays the active settings from code. Editing only `BACKTEST` from `1m`/15 sessions to `15m`/5 sessions changed the displayed range, loaded 285 stored 15-minute bars, and completed five trades.
- Confirmed the default code-configured run completed 13 trades with the USD 50,000 starting capital shown in statistics.
- Confirmed Auto strategies rendered `First EMA5`, `False EMA5`, and volatility `EMA5` labels with current point values while retaining the compact chart heights.
- Targeted lint, three code-configuration tests, eight order-engine tests, and Auto strategy tests passed. The market-data audit passed with zero errors; its two warnings were the existing CBBC publication and Futu cash-cache freshness notices.

### 2026-10-05 — Add the Image Search tab

User request:

- Add a tab named Image Search as the first step toward matching an uploaded image against chart data, without using the Case Panel.

Implementation:

- Added an Image Search item to the top navigation, linking to `/image-search`.
- Added a page at that route with the Image Search heading. Existing Main Data, Backtest, and Chart Data tabs are unchanged.

Verification:

- Opened `/image-search` and confirmed the Image Search tab is highlighted and the page heading is shown.
- Switched to Chart Data and back to Image Search; both routes loaded and the active tab followed the route.

### 2026-10-05 — Match an uploaded image to stored candles

User request:

- Build the Image Search function so an uploaded image returns a similar pattern from the chart data, without the Case Panel.

Implementation:

- The Image Search page traces the uploaded image into a price shape, then compares that shape with stored `HK.HSImain` daily closes in `data/backtest.sqlite`.
- The comparison is scale-free and reads stored bars only. It does not refresh Futu, Yahoo, or any other provider.
- The closest non-overlapping windows are listed with their dates and match score. The selected window is drawn as candles, with the uploaded shape scaled onto that window.

Verification:

- A planted 48-close window was recovered from the full 4,923-bar series at score 1.0, and the shape-tracing test recovered a drawn V.
- Dropping a zigzag image on the Image Search page listed five stored windows and drew the selected 2014-03-25 to 2014-06-05 stretch with the blue shape following those candles. Choosing another result changed the chart. The search reads SQLite only.

### 2026-10-05 — Stop Image Search from inventing a match

User request:

- The Image Search results were not actually the uploaded shape.

Implementation:

- A result is kept only when the stored daily closes follow the uploaded path point for point, including the direction of each move. Short windows are no longer stretched until a loose correlation looks high.
- The candle chart shows the stored bars alone. The uploaded shape is drawn against the matched closes on a separate comparison, so a line is not painted over prices it does not follow.
- If nothing in the stored history follows the image, the page says so instead of listing a nearest guess.

Verification:

- A line drawn from the 80 daily closes starting 2015-09-22 was recovered at that exact window in 57ms, with the closes 0.11 standard deviations from the traced shape.
- The same search returned no hit for a zigzag that the stored closes do not follow, and no hit for a zigzag against a straight rising series.

### 2026-10-05 — Read candles out of an uploaded chart image

User request:

- The Image Search result for an uploaded candlestick chart was unusable.

Implementation:

- A candlestick screenshot is split into individual candles. Grid lines and the volume pane are removed, and each candle contributes its close, using the body color to tell which end is the close.
- The search looks for that many bars in stored daily and 15-minute HK.HSImain history. A window is returned only when those closes follow the extracted candles.
- The traced preview is the candle closes themselves, so the blue line is the path that was searched.

Verification:

- A generated screenshot of the 60 daily bars from 2015-09-22, including grid lines, wicks, red and green bodies, and a volume pane, was recovered at that window.
- A zigzag still returns no stored stretch.

### 2026-10-20 — Remove private chart/image features and isolate all data

User request:

- Totally remove Chart Data and Image Search before open-sourcing and deploying the app.
- Move all private data into a separate folder.

Implementation:

- Removed the Chart Data navigation/route/component and the Image Search, case upload/search, image-transform routes, components, tests, Python services, and image-only dependencies. The root route now redirects to Main Data, leaving only Main Data and Backtest in navigation.
- Moved the complete 2.6 GB local data and removed-feature archive outside the repository to the sibling `trading-tools-private-data/` directory. This checkout uses an ignored `.env.local` to set `TRADING_TOOLS_DATA_DIR=../trading-tools-private-data/runtime`.
- Added one data-path module and moved market SQLite, backtest SQLite, provider caches, backtest caches, and inspection mirrors behind `TRADING_TOOLS_DATA_DIR`. New clones default to the ignored `private-data/runtime/` directory. Generated data is no longer written to `public/`.
- Expanded `.gitignore` to block the private data root, legacy data/image paths, generated public mirrors, and local process files. The README and server instructions now describe the open-source-only app and private storage contract.
- Made cached Main Data refreshes absorb unavailable-OpenD background failures instead of crashing the server. Auto backtests render last verified SQLite history immediately while a stale tail refreshes in the background.
- Switched production builds to webpack because Turbopack followed the local ignored `.venv-futu` symlink outside the project root; excluded private archives and test-only TypeScript from application compilation.

Verification:

- Production build passed with Node 22.23.0. Auto-strategy tests passed; all 8 backtest-engine tests and all 3 Python configuration tests passed.
- The market-data audit passed with 0 errors: 227 official HKEX open-interest rows, 211 long-flow rows, and 112 short-flow rows. Five expected warnings remained for the stale local Futu cache and four stale backtest timeframes while OpenD was not running.
- Confirmed the app reads the relocated databases: 1,944,825 stored 1-minute bars were available, and `/api/backtest/auto` returned 22,425 bars for 10 dates with `storage: backtest.sqlite` while marked delayed.
- In the browser, navigation showed only Main Data and Backtest. Main Data completed and reset its five-second refresh countdown; Backtest rendered all 10 stored dates and delayed-state metrics without waiting for OpenD.
- `/futu`, `/image-search`, `/upload`, `/api/image-search`, and `/api/image-transform` all returned 404. `public/` contains only generic static SVG assets; no runtime data directory or image service remains in the repository working tree.

### 2026-10-21 — Prepare a history-free public repository and Windows VPS runtime

User request:

- Create a new public GitHub repository named `trading-tools-public` without the old private-data history.
- Deploy on a Windows Server 2022 VPS without transferring the existing private archive.
- Clarify whether Futu software is required on the VPS.

Implementation:

- Added a Windows-aware Python resolver so Next.js uses `python.exe` and `.venv-futu\\Scripts\\python.exe` on Windows while preserving the Unix virtual-environment paths.
- Made every Futu bridge honor `FUTU_HOST` and `FUTU_PORT`, retaining the private `127.0.0.1:11111` defaults.
- Added `requirements-futu.txt` for the official Futu Python client and Windows IANA timezone data. Futu OpenD remains a separate, required gateway process.
- Added Windows Server install, startup, and Scheduled Task scripts. Source stays in `C:\\TradingTools\\app`; newly fetched runtime data, configuration, Python environment, OpenD, and logs remain outside Git.
- Added an MIT license and Windows deployment documentation. The clean VPS starts with an empty data directory and does not receive the user's historical databases, caches, images, or backup archive.

Verification:

- Targeted ESLint, Auto strategy tests, four expiry tests, eight backtest-engine tests, three Python-configuration tests, and the production Next.js build passed under Node 22.23.0.
- The market-data audit passed with zero errors. Five expected warnings remain because local OpenD was not running: one stale Futu live cache and four backtest timeframes behind the last closed session.
- Created a one-commit, history-free public snapshot containing 98 source/configuration files and no runtime database, generated image, private environment file, oversized artifact, credential pattern, or user-specific absolute path.

### 2026-10-21 — Add a safe public-viewing mode

User request:

- Put the website on the internet so anyone can view it without exposing Futu OpenD or unsafe server capabilities.

Implementation:

- Added an explicit public mode for the Windows deployment. It keeps OpenD on localhost and keeps the generated SQLite/cache directory outside the public repository.
- Enforced public mode in the Windows install and startup scripts, including on servers whose production configuration file predates the safety setting.
- Public mode disables visitor-submitted Python strategy execution, manual backtest refreshes, on-demand Futu candle extraction, forced provider-refresh query parameters, startup mutation checks, and shared market-order writes.
- The public UI exposes Auto strategies as a stored-data view but removes the Python strategy tab and manual server-refresh button. Automatic verified-data reads and the existing controlled provider cadences remain intact.

Verification:

- The public-mode production build passed under Node 22.23.0, and the market-data audit passed with zero errors and the five previously disclosed stale-OpenD/backtest warnings.
- The production `/market-data` page returned HTTP 200. Public requests to Python execution, manual backtest refresh, and shared market-order writes each returned HTTP 403.
- In a headless browser after an eight-second render, Backtest showed only the Auto strategies view with stored results; the Python strategy tab was absent and the existing charts remained usable.

### 2026-10-21 — Harden the Windows public deployment and separate background work

User request:

- Security-review every public API and deploy the existing public repository to a Windows VPS through Tailscale Funnel without exposing Futu OpenD, credentials, databases, or unrelated applications.
- Keep the architecture simple and reusable for multiple independent applications, replace the `SYSTEM` task, add tests/health/logging/recovery, and provide exact deployment commands.
- Commit and push the reviewed changes, but do not change the VPS or expose the site before checks pass.

Implementation:

- Separated the public Next.js process from a bounded `public_data_worker.js`. Public-mode routes now read verified SQLite/disk state only for Futu, CBBC, HKEX, HSI history, backtest candles, and related-market caches; only the worker may invoke Python/Futu or persist provider refreshes.
- Added five-second Futu cash/futures and complete-CBBC worker jobs, controlled 60-second full/intraday refreshes, five-minute CITIC refreshes, 15-minute HKEX/related-market refreshes, and hourly completed-session backtest tail refreshes. Every Futu subprocess retains the localhost assertion, timeout, output cap, completeness checks, and last-verified-cache behavior.
- Replaced the `SYSTEM` Scheduled Task with separate limited `TradingToolsWeb` and `TradingToolsWorker` tasks under a required `TradingToolsSvc` local account. Added scoped ACL setup, bounded log rotation, restart settings, one-command local deployment, an isolated updater, a sanitized health endpoint, and a health-gated Funnel publisher.
- Added global and per-client API rate caps, request size limits, an allowlist for Yahoo chart symbols, bounded numeric inputs, generic public errors, and security headers. Migrated Next middleware to the current proxy convention.
- Documented every endpoint and trust boundary in `SECURITY.md`, plus the multi-application loopback-port convention, exact PowerShell workflow, Funnel hostname/port/path limitations, rollback, and how to add another application without exposing it.
- Upgraded Next.js from 16.1.6 to 16.4.2 and ECharts from 5.6.0 to 6.1.0 after the audit found a critical Windows-hosted Next.js RCE and an ECharts XSS advisory. Production dependencies now report zero advisories; five high advisories remain confined to the ESLint development dependency graph because its latest upstream release has no non-breaking resolution.
- Added a production-server integration test proving public Python/refresh/mutation restrictions, request limits, symbol validation, sanitized failures, and browser security headers.

Verification:

- Pinned Node 22.23.0 production build passed on Next.js 16.4.2, targeted lint passed, and the public security integration suite passed.
- Auto strategy tests, four expiry tests, eight backtest-engine tests, and three Python-configuration tests passed.
- `npm audit --omit=dev` reported zero production vulnerabilities.
- The market-data audit passed with zero errors: 227 official HKEX rows through 2026-10-20, 211 long-flow rows, 112 short-flow rows, and a complete 2,912-product/1,094-level Futu CBBC snapshot. Five expected warnings remained for the locally stale Futu cache and four backtest timeframes while OpenD was offline.
- Observed the rendered production Main Data page complete a five-second refresh: the Refresh button returned from `REFRESHING…` to `REFRESH ALL DATA`, chart/panel geometry stayed mounted, and the browser console had zero warnings or errors.
- No Windows VPS, Tailscale Funnel, firewall, OpenD, database, or credential change was executed from this development machine.

### 2026-10-21 — Repair Windows native modules, security tests, and service setup

User request:

- Diagnose and fix the Windows VPS failures involving `better-sqlite3`, the public-security test, locked Next.js SWC files, and the service-account `SecureString` handoff.
- Preserve existing databases, OpenD, configuration, and application data; keep the site private until SQLite, security, startup, and low-privilege account checks pass; commit and push the repair.

Diagnosis:

- The installer ran `npm ci` while the existing web/worker Node processes could still hold SWC and SQLite native modules open. Windows therefore returned `EPERM`, and the stale SQLite binary remained incompatible with Node ABI 127.
- The SQLite repair re-probed the native module in the same Node process that had already failed to load it, so a successful rebuild was not independently verified.
- The security test spawned the `npm.cmd` command shim directly. Current Windows Node process spawning rejects that batch-command path with `EINVAL` unless a shell is introduced.
- `deploy.ps1` passed a `SecureString` through a new `powershell.exe -File` process. PowerShell serialized it as the text `System.Security.SecureString`, which cannot bind back to a secure-string parameter.
- Windows also enforces a 48-character maximum for a local-user description; the original service-account description was 55 characters and would have become the next account-creation failure after fixing the secure-string handoff.

Implementation:

- Stop only Trading Tools scheduled tasks and app-scoped `node.exe` processes before modifying dependencies; wait for native-module handles to close while leaving OpenD, Tailscale, data, configuration, and unrelated applications untouched.
- Re-probe `better-sqlite3` in a fresh Node subprocess before and after repair, run a real query, and repeat the check after production pruning. Exact already-verified releases skip unnecessary npm/Python installation and rebuilding.
- Launch the public-security Next server directly through `node.exe` and Next's JavaScript entry point, with bounded cross-platform shutdown and cleanup.
- Keep the service password as a `SecureString` in one PowerShell runspace, use plaintext only transiently inside the Task Scheduler API call, never log or persist it, and reject administrator/SYSTEM principals.
- Shortened the non-sensitive service-account description to fit the Windows local-account limit.
- Added a one-time limited scheduled-task check proving the service identity can load SQLite and write/read the private data directory. Final verification also requires both limited tasks running, ready health, and a loopback-only listener; any failure leaves Funnel disabled.
- Added a Windows Server 2022 GitHub Actions gate for the pinned Node ABI, a real SQLite read/write, production build, public-security suite, PowerShell parsing, secure-string account creation, and non-administrator membership.

Verification:

- Under pinned Node 22.23.0 / ABI 127, `better-sqlite3` loaded in fresh processes, completed in-memory and private-directory write/read queries, and removed its temporary verification database.
- The public production build and complete public-security integration suite passed; production dependency audit reported zero vulnerabilities.
- Auto-strategy tests, four expiry tests, eight backtest-engine tests, and three Python strategy-configuration tests passed.
- The real-data audit passed with zero errors: 227 official HKEX rows through 2026-10-20, 211 long-flow rows, 112 short-flow rows, and a complete 2,912-product/1,094-level Futu CBBC snapshot. Five expected warnings remained for the offline/stale local OpenD cache and four backtest timeframes.

### 2026-10-21 — Install build dependencies in the Windows production environment

User request:

- Diagnose the follow-up VPS build failure after the Windows native-module and service-account repair.

Diagnosis:

- `production.ps1` correctly set `NODE_ENV=production` before installation, but npm consequently omitted every development dependency. The VPS installed only 75 packages instead of the full locked build toolchain.
- The missing `@tailwindcss/postcss` caused the direct CSS build error. Missing TypeScript/build tooling also caused Webpack to report tracked TypeScript modules such as `clientDiag.ts` and `cbbcKnockout.ts` as unresolved; those files were present in Git and passed the Windows CI build when the complete toolchain was installed.

Implementation:

- Made Windows installation explicitly run `npm ci --include=dev` for the build phase while keeping `NODE_ENV=production`, then retain the existing post-verification `npm prune --omit=dev` security step.
- Changed the Windows Server 2022 CI job to reproduce the production environment and assert that Tailwind/PostCSS and TypeScript are installed before building.
- Preserved all runtime databases, configuration, OpenD, Python packages, tasks, and logs; the failed deployment never reached service-account or publication steps.

### 2026-10-21 — Resume after a Windows password-policy rejection

User request:

- Determine whether the failed `New-LocalUser` attempt partially created `TradingToolsSvc`, resume after the already successful build without reinstalling, retry policy-compliant passwords safely, and explain the differing npm audit results.

Implementation:

- Added a guarded `deploy.ps1 -Resume` path. It skips installation/build only after verifying the completed release stamp, unchanged package lock, an existing production build, no application-source changes since that build, and a fresh SQLite native-binding probe.
- Kept account creation idempotent: an absent account is created and an existing dedicated account is updated; no unrelated account or Windows password policy is changed.
- Added up to three hidden `SecureString` password attempts when Windows specifically returns `InvalidPassword`. Rejected values are discarded without logging, persistence, or process-command-line exposure; other account errors still stop immediately.
- Preserved the separate final gates for a non-admin limited principal, service-account SQLite/data-directory access, scheduled-task identity, application health, and loopback-only listening. Funnel remains a separate explicit action.
- Confirmed the apparent npm discrepancy is intentional: the initial five advisories are confined to the build-only development graph, while `npm audit --omit=dev` validates the production graph at zero vulnerabilities and `npm prune --omit=dev` removes build-only packages before runtime.

### 2026-10-21 — Generate and protect the Windows service password

User request:

- Generate a strong service-account password automatically and save it privately because the user does not want to invent or type one.

Implementation:

- Generate a cryptographically random 48-character password containing uppercase, lowercase, numeric, and symbol characters, excluding visually ambiguous characters.
- Convert the value immediately to `SecureString`, never print it, and store a DPAPI-encrypted `PSCredential` under `C:\TradingTools\config` rather than the worker-writable market-data directory.
- Remove inherited access from the credential file and grant access only to local Administrators and SYSTEM. Reapply that file ACL after broader read permissions are granted to `TradingToolsSvc`, so the limited service identity cannot read its saved credential.
- Load the encrypted credential automatically for resume and later deployments. Added explicit rotation and manual-prompt switches for recovery without changing Windows password policy.
- Extended Windows Server CI to generate, ACL-protect, reload, length-check, and use the encrypted credential to create a temporary non-administrator service account.

### 2026-10-21 — Correct temporary Scheduled Task cleanup

User request:

- Continue deployment after automatic credential generation and low-privilege account creation succeeded but temporary verification-task cleanup failed.

Implementation:

- Replaced the nonexistent `Remove-ScheduledTask` call with Windows' supported `Unregister-ScheduledTask` cmdlet.
- Kept cleanup idempotent and non-interactive; rerunning safely replaces the temporary verification task and both application tasks using the already encrypted credential.
- Expanded Windows Server CI to assert that every ScheduledTasks cmdlet used by deployment exists, preventing another parser-valid but unavailable command from reaching the VPS.

### 2026-10-21 — Resolve the local account for Task Scheduler

User request:

- Continue the guarded Windows deployment after Task Scheduler rejected the existing `TradingToolsSvc` account with “No mapping between account names and security IDs was done.”

Diagnosis:

- The encrypted credential intentionally stores the local shorthand `.\\TradingToolsSvc`. PowerShell account cmdlets accept that shorthand, but the ScheduledTasks CIM provider on the VPS attempted to translate it literally and rejected its `UserId` even though the local account existed.

Implementation:

- Resolve the verified local user's SID back to its canonical machine-qualified NT account name and confirm it translates to the same SID before passing it to Task Scheduler.
- Keep the password inside the existing DPAPI-backed credential flow; it is exposed only transiently to the in-process Task Scheduler API and is never printed or placed on a process command line.
- Added a Windows Server CI integration check that creates a temporary limited Scheduled Task with a generated local account, verifies the registered principal SID, and removes both safely.
- Preserve the completed build, application data, OpenD, configuration, encrypted credential, and existing service account. Funnel remains disabled until final runtime verification succeeds.

### 2026-10-21 — Make the Windows deployment self-verifying

User request:

- Stop requiring repeated manual diagnosis from broken terminal output; make sure the complete Windows deployment is functional and secure before asking the user to publish it.

Diagnosis:

- Scheduled Task result `267011` is `0x00041303` (“task has not yet run”), but the deployment mislabeled it as a SQLite/data-directory failure.
- Account setup printed manual Local Security Policy instructions instead of enforcing the exact rights required by the service identity.
- Runtime scripts depended on the administrator's `PATH` and `npm.cmd`, which are not reliable in a different local account's noninteractive Task Scheduler session.
- The updater referenced nonexistent `Restart-ScheduledTask`, another cmdlet error that would only appear on a future update.
- The temporary runtime log was not tied to the current deployment attempt, allowing stale output to be mistaken for a fresh check.

Implementation:

- Configure only the dedicated account's required Windows rights: grant batch logon, remove a direct deny-batch assignment, and deny local and Remote Desktop interactive logon. Preserve every other account already present in those policies.
- Enable the dedicated local account when necessary, keep it outside Administrators, and continue applying read-only application/configuration access plus modify access only to data and logs.
- Pin the exact verified Node 22.23.0 and npm executables in an administrator-owned configuration file. Runtime tasks prepend that Node directory to their private `PATH` and start through the existing npm scripts; the worker and limited-account verifier also run an explicit fresh SQLite probe.
- Give every limited-account runtime check a unique nonce, remove its old log before execution, and accept it only after the current task finishes successfully and writes the matching nonce plus the SQLite/data write-read result.
- Report task-never-ran separately from application verification failure, including task state and hexadecimal Scheduler result while always keeping Funnel disabled.
- Replace the nonexistent updater restart cmdlet with explicit stop/start operations.
- Extend Windows Server CI from task registration alone to actual execution under the temporary non-administrator identity, with the same account-rights setup and cleanup.

### 2026-10-21 — Gate public Funnel exposure on the complete verification suite

User request:

- Explain how to make the verified Windows deployment public and how to know that it is safe to expose.

Implementation:

- Changed the Funnel publisher to rerun the complete deployment verification immediately before changing public exposure, rather than checking only the health endpoint.
- Refuse publication unless the dedicated account remains non-administrative, both limited tasks are running under its SID, the current service-account SQLite/data check exists, application health is ready, and port 3000 remains loopback-only.
- Continue exposing only `http://127.0.0.1:3000` through Tailscale HTTPS on an explicitly allowed Funnel port; no Windows inbound firewall port is opened and OpenD remains unreachable from Funnel.
- Require a successful Funnel status read after configuration and retain the documented one-command disable operation.

### 2026-10-21 — Restore accumulated private capital-flow history securely

User request:

- Restore the missing long/short capital-flow history on the public VPS and enforce durable SQLite accumulation without publishing the private database.

Diagnosis:

- The preserved workstation `market.sqlite` contains 211 CITIC long rows from 2025-12-09 through 2026-10-20 and 112 short rows from 2026-05-11 through 2026-10-20, with a passing SQLite integrity check.
- The fresh VPS `market.sqlite` contains only 19 long and 19 short rows from 2026-09-22 through 2026-10-20 because each CITIC endpoint returns a rolling one-month window. Repeated fetching cannot reconstruct dates that have already left that provider window.
- The current worker already performs correct five-minute upserts and never deletes old dates; the missing step is a private one-time historical seed into that same database, not a competing second source of truth.

Implementation:

- Added a money-flow-only SQLite seed importer that rejects corrupt databases, duplicate/invalid dates, invalid numeric values, and non-CITIC source URLs.
- Move the transferred seed into an Administrators/SYSTEM-only import directory, create an online pre-import backup under an equally restricted VPS directory, then merge missing long/short dates atomically with existing VPS rows taking precedence on overlaps.
- Record the seed SHA-256, import time, row counts, and date coverage inside `money_flow_imports` for auditability and idempotence.
- Verify SQLite integrity after import, confirm the running loopback APIs expose every stored row, and rerun the complete service-account, task, health, and loopback security gate.
- Persist the verified long/short minimum row counts and date coverage outside the source tree; make all later deployment and Funnel verification fail closed if the running APIs fall below that baseline.
- Keep `C:\TradingTools\data\market.sqlite` as the sole source of truth and preserve the existing worker's five-minute provider upserts so future rolling windows accumulate instead of replacing history.
- Added deterministic Windows-compatible tests for merge precedence, idempotence, audit records, backups, and final database integrity.

Verification:

- Generated a private 88 KB money-flow-only seed with SHA-256 `0935e5bef5ea5a09a5affc7c66b456fc54189071351c380745f927b804139bd3`; its integrity check passed with 211 long rows (`2025-12-09`–`2026-10-20`) and 112 short rows (`2026-05-11`–`2026-10-20`).
- Imported that real seed into an isolated Node `22.23.0` target and verified the same counts/ranges, a passing post-import integrity check, one 64-character audit hash, an online backup, and an enforced history-baseline file.
- Ran the deterministic importer twice under Node `22.23.0`; merge precedence, idempotence, unique backups, audit records, baseline output, and SQLite integrity all passed.
- `npm run audit:market-data` passed with 0 errors. Its 5 warnings were pre-existing stale workstation Futu/backtest caches and did not concern the current CITIC money-flow history, which the audit reported as 211 long and 112 short rows through `2026-10-20`.

### 2026-10-21 — Repair public money-flow visibility, exact CBBC Detail, and dashboard clipping

User request:

- Diagnose why restored capital-flow history still did not appear, correct the empty/incorrect CBBC Detail presentation, improve the visibly clipped dashboard UI, and verify that the displayed data is accurately fetched.

Diagnosis:

- Direct inspection of the public APIs proved the VPS still had only 19 long and 19 short CITIC rows (`2026-09-22`–`2026-10-20`); the private seed had not reached that VPS database, so this was not a chart-only defect.
- The public full Futu cache was healthy and complete with 2,896/2,896 NORMAL-status products aggregated into 1,087 exact recovery-price levels, but the five-second live-only cache intentionally contained zero CBBC rows. Public mode returned that lightweight cache without merging the separately verified complete snapshot, so Detail blanked on every live poll.
- Compact stock cards forced symbol, price, and percentage onto one narrow row, truncating `0700`, `9988`, and `0005`. Dense CBBC labels used only two lanes and overlapped when adjacent recovery prices mapped fewer than 15 pixels apart.

Implementation:

- Merge the latest complete disk-backed CBBC universe into public live-only Futu responses; reject any CBBC payload unless its fetched product count equals the provider total.
- Select the nine highest-street-volume exact recovery prices independently for bears and bulls within 1,800 HSI points, preventing one side from crowding the other out while retaining exact Futu prices and HKD-volume aggregation.
- Correct `cbbcActive` to report the counted NORMAL-status products rather than copying the provider total.
- Show the visible CITIC SQLite long/short counts and coverage, the complete Futu product count in Detail, and the JPM outstanding/publication dates in General so source scope and freshness are inspectable in the UI.
- Spread dense CBBC value tags across four collision lanes while keeping every tag on its exact price-line Y coordinate.
- Stack compact stock-card symbols above their quote tuple and use a responsive minimum sidebar width, eliminating the clipped one-character symbols.
- Added pure merge/selection tests and an end-to-end public-mode cache test proving a live-only snapshot receives only a completeness-verified CBBC universe without launching Python.

Verification:

- Pinned Node `22.23.0` production build and TypeScript checks passed; public-security integration tests and the new CBBC merge/selection tests passed.
- Browser verification against an isolated copy of the real 211/112-row private SQLite database rendered the full capital-flow history, 18 exact Futu Detail levels (9 per side), readable collision lanes, complete `2,896/2,896` provenance, and unclipped `0700`/`9988`/`0005` cards.
- Two public live-only reads 6 seconds apart advanced from `2026-10-21T14:15:06+08:00` to `14:15:16+08:00`; Futu `HK.800000` moved from 23,700.24 to 23,700.65 and `HK.HSImain` moved from 23,718 to 23,717 while open interest remained truthfully unchanged at 138,952.
- The market-data audit passed with 0 errors. Five warnings remain limited to stale workstation Futu/backtest caches; the independently queried public feed was current, and the audit confirmed the private CITIC history at 211 long/112 short rows through `2026-10-20`.

### 2026-10-21 — Version the historical capital-flow baseline

User request:

- Hard-code the roughly one year of non-private historical capital-flow data in the codebase instead of transferring a separate SQLite seed file to the Windows VPS.

Implementation:

- Added the verified CITIC HSI baseline to `lib/moneyFlowSeed.js`: 211 long rows from 2025-12-09 through 2026-10-20 and 112 short rows from 2026-05-11 through 2026-10-20.
- Database initialization now inserts missing baseline dates into `market.sqlite` automatically. The inserts are idempotent and never overwrite a row already populated or corrected by a live provider refresh.
- Added deterministic seed tests and market-data audit coverage so fresh deployments must contain every versioned baseline date.
- The Windows deployment no longer requires a downloaded seed database. The hardened importer remains only as an optional compatibility path for any future trusted custom history beyond the built-in baseline.

Verification:

- The fresh in-memory database test passed with exactly 211 long rows and 112 short rows, confirmed a second seed pass inserts zero rows, and confirmed the seed cannot overwrite an existing provider value.
- Targeted ESLint and the production Next.js build passed under pinned Node 22.23.0.
- The market-data audit passed with zero errors and confirmed every versioned baseline date is present. Five unrelated freshness warnings remained for the prior CBBC publication/live Futu cache and completed-session backtest tails while local OpenD was not running.
- The production Main Data page rendered `L 211 / S 112 · 2025-12-09–2026-10-20`; the five-second countdown reset from 1 to 3 seconds while the full history remained visible.

### 2026-10-21 — Add breathing room between related-market cards

User request:

- Add more margin between the compact related-market cards shown on the Main Data dashboard.

Implementation:

- Increased the related-market dashboard grid gutters from 8 pixels to 12 pixels, consistently covering the compact stock row, the compact FX row, and the vertical spacing between chart rows.
- Preserved the responsive column sizing, chart behavior, data sources, and internal card padding.

Verification:

- Targeted lint and production-build checks passed under the pinned Node version.
- Browser inspection confirmed visible, even spacing between the `0700`, `9988`, and `0005` cards without symbol clipping.

### 2026-10-21 — Automatic GitHub deployment, staged loading progress, and outer dashboard margin

User request:

- Avoid manually rebuilding every time GitHub changes, show useful progress while deployment and the dashboard load, and correct the still-missing space above the chart/card area highlighted in the screenshot.

Diagnosis:

- The earlier margin change increased the gutters between related-market cards, but the screenshot identified the page's outer top edge. `/market-data` explicitly forced top and bottom padding to zero, leaving the content against the navigation divider.
- The Windows updater always ran a full pull/install/build path and had no scheduled GitHub-change detector or visible build stages.
- Initial HSI loading exposed only a text message, with no indication of whether the request was connecting, validating, or rendering.

Implementation:

- Added 12-pixel top and bottom dashboard padding so the complete Main Data surface, including the right-hand cards, is visibly separated from the navigation and viewport edges.
- Replaced the initial HSI text-only state with an accessible progress bar driven by real request milestones: connect, receive/validate, prepare history, and render indicators.
- Added an opt-in `TradingToolsAutoUpdate` Windows Scheduled Task that checks `origin/main` every two minutes and builds only when the deployed commit changes.
- Made automatic updates serialize through a named mutex, refuse tracked local changes and non-fast-forward history, keep logs, reuse the existing tested installer, restart only Trading Tools tasks, and run deployment verification.
- Added PowerShell progress stages to manual installation/update and made unchanged commits exit without an unnecessary build.
- Documented registration, interval changes, logs, privilege boundaries, and disabling the automatic updater; added a deterministic deployment-script contract test.

Verification:

- Pinned Node 22.23.0 production build and TypeScript checks passed; public-security integration tests and the Windows automatic-update contract test passed.
- Market-data audit passed with zero errors, 227 official HKEX rows, 211 long-flow rows, 112 short-flow rows, and a complete 2,886-product Futu CBBC snapshot. Four warnings remained for the intentionally preserved stale workstation Futu cache and completed-session backtest tails while local OpenD was offline.
- Browser accessibility inspection observed the initial dashboard progress indicator at 10%, then its removal after verified data rendered. The completed page retained all market data and showed a visible 12-pixel outer margin above both the HSI panel and related-market cards.
- The Windows Scheduled Task was not registered from the macOS development machine; registration remains an explicit one-time Administrator action on the VPS.

### 2026-10-21 — Chart data labels, durable backtest history, and restored strategy editor

User request:

- Label the Main Data chart so long/short capital flow, open interest, volume, and CBBC data are unambiguous.
- Remove the Auto backtest `False-break 1:2` selector, make its stored history usable for longer lookbacks, persist every verified update in SQLite, and explain/restore the missing Python strategy.

Diagnosis:

- A fresh public database fetched only a 14-calendar-day 1-minute tail, so the 1–120-session control could expose a lookback the server did not yet contain.
- The Python strategy tab had been hidden in public mode because executing arbitrary visitor-supplied Python on the Internet-facing server would be remote code execution. Hiding the editor also made user-authored strategy source appear removed.
- The strategy chart's 42 sequential history requests could exceed the public endpoint's per-minute rate limit even though server-side execution was disabled.

Implementation:

- Added a compact on-chart legend identifying HSI cash, bear/bull CBBC levels, futures volume, long/short capital flow, and open interest.
- Removed the false-break reward/risk selector and fixed the existing analysis rule internally at 2R; renamed the action to **Recalculate** and added an explicit SQLite session/bar coverage badge.
- Hard-coded a 120-session 1-minute retention target. The five-minute public worker now updates a missing closed-session tail first, then fetches older verified Futu data in 30-day chunks. Every chunk uses the existing timestamp-keyed SQLite upsert and never deletes older candles.
- Restored the Python strategy tab in public mode as a safe editor. Its source is stored in browser local storage so deployments do not erase it; public server execution and manual mutation remain disabled, while private/local installations retain execution.
- Limited the public strategy preview to one stored-history request, avoiding the public rate limit, and kept the full progressive history loader for private/local use.

Verification:

- Node 22.23.0 production build and TypeScript checks passed; public-security, Windows auto-update, backtest-storage policy, and auto-strategy tests passed.
- Market-data audit passed with zero errors. It reported four expected stale-cache warnings while local Futu OpenD was offline; SQLite retained 1,945,800 one-minute bars and 2,495 stored dates.
- Browser verification showed the complete Main Data legend, a live five-second countdown cycle, the Auto view without the false-break selector, populated SQLite coverage/results, and the restored public Python workspace with disabled execution controls.
- Browser persistence was verified by editing strategy source, reloading the page, and observing the same source restored from local storage.
- Live deployment monitoring found the scheduled task remained on the previous release when it ran as `trader` against an Administrator-owned checkout. Added an exact, command-scoped Git `safe.directory=C:\TradingTools\app` setting to update and install Git commands so the service account can deploy without disabling ownership protection globally.

### 2026-10-21 — Label both capital-flow panes

User request:

- Add a clear label for capital flows on the Main Data chart.

Implementation:

- Added an in-pane label to the long/好倉 capital-flow histogram identifying blue as inflow, red as outflow, and the unit as HKD million.
- Added a separate in-pane label to the short/淡倉 capital-flow histogram identifying red as inflow, blue as outflow, and the unit as HKD million.
- Kept the existing provider, series values, SQLite history, pane geometry, and five-second refresh behavior unchanged.

### 2026-10-22 — Correct the VPS chart legend for capital flow

User request:

- Correct the capital-flow tags on the deployed VPS chart so the blue/red meanings are accurate for both long and short positions.

Diagnosis:

- The VPS source already colored the histogram bars and in-pane descriptions correctly, but the compact top legend used one blue marker for the entire Long series and one red marker for the entire Short series. That implied each position side had only one color and hid the opposite-color outflow meaning.

Implementation:

- Replaced the misleading single blue Long marker and single red Short marker in the top chart legend.
- The Long tag now shows blue inflow and red outflow; the Short tag shows red inflow and blue outflow.
- Kept the existing in-pane labels, CITIC values, SQLite persistence, and five-second refresh behavior unchanged.

Verification:

- The pinned Node 22.23.0 production build and TypeScript checks passed.
- The market-data audit passed with zero errors against the preserved data store: 229 official HKEX rows, 213 long-flow rows, and 114 short-flow rows. Four existing workstation freshness warnings remained for the offline Futu cache and completed-session backtest tails.

### 2026-10-22 — Recover a pulled but unbuilt VPS release

User request:

- Diagnose why the VPS updater reported commit `1358338` as current while the public site still displayed the previous legend, and finish the deployment safely.

Diagnosis:

- The updater returned early whenever local Git `HEAD` matched `origin/main`, without checking whether that commit had completed the production build and written the installed-release stamp.
- A prior update had pulled the source commit but had not installed it, leaving the old `.next` build running. Re-running the updater therefore incorrectly said that no build was required.

Implementation:

- The updater now treats source state and installed-release state separately.
- It skips work only when Git is current, `.next/BUILD_ID` exists, and the installed-release stamp matches both the current commit and package-lock hash.
- If the source is current but the build or stamp is incomplete, it continues through the existing build, security tests, task restart, and deployment verification instead of returning early.
- Extended the Windows auto-update contract test to require the installed-release recovery checks.

Verification:

- The deterministic Windows automatic-update contract test passed under the pinned Node 22.23.0 runtime.
- Confirmed the recovery path retains the existing fail-closed build, security-test, task-restart, and deployment-verification sequence.
