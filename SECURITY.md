# Security model

Trading Tools is a public, read-only website backed by a private data worker. HTTPS exposure does not make the application safe by itself; the controls below are the security boundary.

## Trust boundaries

- The public Next.js process listens only on `127.0.0.1:3000` and runs with `TRADING_TOOLS_PUBLIC_MODE=1`.
- Tailscale Funnel is the only public listener and proxies only to `127.0.0.1:3000`.
- The background worker runs as the dedicated `TradingToolsSvc` Windows account. It alone starts the Python/Futu bridges and writes provider caches and SQLite data.
- Futu OpenD remains on `127.0.0.1:11111`. The code rejects a non-loopback `FUTU_HOST`.
- Runtime data, credentials, configuration, logs, and Python packages live outside the Git checkout under `C:\TradingTools`.

## Public API inventory

| Endpoint | Public behavior | Provider/process side effect |
|---|---|---|
| `GET /api/health` | Read sanitized readiness counts | None |
| `GET /api/backtest/auto` | Read stored 1-minute candles and calculate bounded summaries | None |
| `GET /api/backtest/candles` | Read stored candles only | None in public mode |
| `POST /api/backtest/run` | `403` | Python execution blocked |
| `POST /api/backtest/refresh` | `403` | Futu refresh blocked |
| `GET /api/futu/candles` | `403` | Python/Futu execution blocked |
| `GET /api/futu/market-data` | Read verified disk cache | None |
| `GET /api/futu/hsi-intraday` | Read verified disk cache | None |
| `GET /api/cbbc/latest`, `GET /api/cbbc/history` | Read SQLite/cache | None in public mode |
| `POST /api/cbbc/refresh` | `403` | Provider refresh blocked |
| `GET /api/moneyflow/long`, `GET /api/moneyflow/short` | Read SQLite | None |
| `POST /api/moneyflow/refresh` | `403` | Provider refresh blocked |
| `GET /api/hkex/open-interest` | Read SQLite | None in public mode |
| `GET /api/hsi` | Read stored candles | None in public mode |
| `GET /api/hsi/live` | Bounded read from the public quote provider | No persistence or subprocess |
| `GET /api/markets`, `GET /api/markets/chart` | Read stored quotes/charts; chart symbols are allowlisted | None in public mode |
| `GET /api/markets/order` | Read shared display order | None |
| `POST /api/markets/order` | `403` | Shared-state write blocked |
| `POST /api/startup` | `403` | Administrative checks blocked |

All other mutating API methods are denied by middleware in public mode. Requests have path/query/body size limits, per-path rate limits, a global safety cap, provider timeouts, bounded Python output, and subprocess deadlines.

## Confirmed remediations

- Public `GET` requests no longer launch Python/Futu refreshes or migrate/write fallback data.
- The former `SYSTEM` Scheduled Task configuration was replaced with a required low-privilege account and separate web/worker tasks.
- Arbitrary chart symbols are rejected.
- Python execution, manual refresh, startup mutation checks, and shared ordering writes return `403`.
- Security headers disable framing, MIME sniffing, unnecessary browser capabilities, and cross-origin embedding.
- Public errors are generic for subprocess/provider failures.

## Remaining risks

- Funnel has non-configurable bandwidth limits and is not a full web application firewall or DDoS service.
- In-process rate limiting resets on restart and is suitable for one Windows process, not a multi-node deployment.
- The worker necessarily has read access to the Futu Python environment and write access to Trading Tools data. Keep the account out of Administrators and deny interactive/RDP logon.
- SQLite availability depends on the VPS disk. Back up `C:\TradingTools\data` with a VPS-level, access-controlled backup policy.
- Dependency advisories and the Windows/Tailscale/OpenD patch level require ongoing review.

Report suspected vulnerabilities privately to the repository owner; do not include credentials, account numbers, or production data in a public issue.
