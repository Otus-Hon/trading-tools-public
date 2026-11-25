# Trading Tools

A live dashboard for following the Hang Seng Index (HSI) and exploring HSI futures trading ideas.

[Open the public dashboard](https://hsi-tools.tail50a8bb.ts.net/market-data)

## What you can see

**Main Data** puts the HSI price chart, CBBC levels, futures volume, capital flow, and open interest in one view. The live price comes from Futu. The page checks for new live data every five seconds; daily reports update when their providers publish them. If a source is delayed, the dashboard keeps its last verified values and shows that they are stale.

On the chart:

- **General** shows 100-point CBBC outstanding bands. **Detail** shows exact recovery prices from Futu. The KO alert follows the level shown in the selected view.
- **15 minute** opens a closer view of HSI spot prices and CBBC levels.
- The lower panes show futures volume, long and short capital flow, and official futures open interest. Blue and red capital-flow bars have different meanings in the long and short panes; read each pane's label.

**Backtest** lets you inspect automatic strategy summaries and write a Python strategy. The public site saves your Python text in your browser, but does not run arbitrary Python on the public server. Run custom strategies in a private installation.

The site is designed for a phone as well as a desktop. Scroll down on Backtest to see the full set of charts and results.

## Where the numbers come from

| What you see | Source |
| --- | --- |
| Live HSI cash price and daily candles | Futu `HK.800000` |
| Futures volume and live main-contract position | Futu `HK.HSImain` |
| CBBC levels | Futu for exact recovery prices; J.P. Morgan for 100-point outstanding bands |
| Long and short capital flow | CITIC |
| Official HSI futures open interest | HKEX daily report, all contracts total |

These figures describe different instruments and update on different schedules. In particular, Futu's main-contract position is displayed separately from HKEX's all-contract open-interest total. For exact source rules, update schedules, and persistence requirements, see [REQUIREMENTS.md](REQUIREMENTS.md).

## Run it yourself

You need Node.js **22.23.0** (the version in `.nvmrc`), npm, and Futu OpenD with the required market-data access. Keep OpenD on a private, loopback-only connection.

```bash
nvm use
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The app redirects to Main Data. The npm start and build scripts check that the native SQLite module works with the selected Node version before starting Next.js.

The app stores market history in SQLite under the Git-ignored `private-data/runtime/` folder. Set `TRADING_TOOLS_DATA_DIR` if you want that private data elsewhere. Do not commit runtime data. A new installation must connect to its providers before live values appear.

## For maintainers

- [REQUIREMENTS.md](REQUIREMENTS.md) records the product rules, source identities, and implementation history.
- [Windows deployment guide](deploy/windows/README.md) covers the VPS setup and update process.
- [SECURITY.md](SECURITY.md) explains the public/private boundary. Public visitors cannot start provider jobs or change shared data.
- `npm run test:public-security`, `npm run test:backtest-storage`, and `npm run audit:market-data` check the public boundary, stored backtest history, and market-data contracts.

This is a research tool, not a trading recommendation. Check the source and timestamp before acting on a value.
