---
name: audit-real-market-data
description: Audit the Trading Tools dashboard for real market-data correctness. Use when changing or diagnosing HSI prices/candles, futures volume or open interest, CBBC levels, money flow, related-market charts, refresh cadence, cache fallbacks, SQLite persistence, provider symbols, timestamps, units, or contract-roll behavior.
---

# Audit Real Market Data

## Workflow

1. Read `README.md`, `REQUIREMENTS.md`, and `AGENTS.md` completely.
2. Read [references/data-contract.md](references/data-contract.md) before interpreting any value.
3. Run:

   ```bash
   npm run audit:market-data
   ```

4. Treat every metric as a tuple: provider, exact symbol/field, instrument scope, unit, timestamp, and update cadence.
5. Trace provider response → normalization → SQLite/cache write → API read → chart series.
6. Reject these patterns:

   - joining cash-index and futures prices as one metric;
   - joining main-contract and all-contract open interest;
   - promoting cached payloads as live without a stale indicator;
   - overwriting an authoritative completed row with a lower-priority live source;
   - force-fetching daily providers on a five-second UI cycle;
   - filling missing market observations with invented OHLC values;
   - silently presenting a proxy instrument as the named market.
   - using `HK.HSImain.origin_code` for the expiry display when it has rolled before the expiring calendar contract's final HKT date;
   - aggregating Futu CBBC recovery levels from only the first warrant page or any other incomplete product universe;

7. Verify at least one five-second cycle in the running UI. Confirm timestamps advance for live Futu fields while official daily rows remain unchanged.
8. Append the request, diagnosis, implementation, row counts, and verification evidence to `REQUIREMENTS.md`.

## Source decisions

- Prefer Futu OpenD `HK.800000` for all live HSI cash fields on the Futu page.
- Use Futu `HK.HSImain` for rolling main-contract volume and live position. Both daily and 15-minute HSI cash candles use `HK.800000`.
- For the expiry display, query the exact current and next calendar-month HSI contracts. Keep the current month through its provider-reported final HKT date and roll only on the next HKT date.
- Use HKEX `All Contracts Total` only for the continuous official open-interest history.
- Keep daily provider histories cached/persisted; reread them every UI cycle but refetch them at their documented cadence.
- Preserve last verified data on transient failure and visibly mark it stale.

## Audit output

Fix all `ERROR` findings before delivery. Explain `WARN` findings that remain legitimate, such as a daily provider not yet publishing today or a disclosed proxy fallback.
