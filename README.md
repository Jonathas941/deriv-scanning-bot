# Deriv Scanning Bot

A Node/TypeScript service that scans Deriv markets on a fixed cadence, scores each
symbol with a multi-indicator confluence model, and optionally executes Rise/Fall
contracts under hard risk circuit breakers. Ships a REST API, a live dashboard, and
outbound webhooks.

> **This software can lose money.** It is an automated trading system with no track
> record. The author of this code is not a financial advisor and this is not
> financial advice. Run it on a demo account until *you* have satisfied yourself
> that the signals are worth acting on. Real trading is off by default and stays
> off until you deliberately turn it on.

---

## Safety model

Three independent layers have to agree before a single order is sent.

1. **`ENABLE_REAL_TRADING` defaults to `false`.** In this state the bot does
   everything except send the order: it scans, scores, requests a real price
   quote from Deriv, records what it *would* have done, and logs it. A typo in
   this variable is a startup error, not a silent `true` — safety flags fail closed.
2. **Account assertion.** `DERIV_ACCOUNT_TYPE` is cross-checked against the
   account the token actually authorises. If you say `demo` and the token opens a
   real account, the bot refuses to start rather than warning and continuing.
   `DERIV_ACCOUNT_ID` optionally pins an exact login ID.
3. **Circuit breakers.** Daily loss limit, max drawdown from peak, and consecutive
   losses each halt trading permanently until a deliberate resume. Halts are
   persisted to disk, so a restart does not clear one — an automated system that
   un-halts itself after a loss streak is how accounts get emptied.

The real-money gate is checked in `Executor.execute()`, immediately before the
buy leaves the process, so no upstream refactor can route around it.

---

## Quick start

```bash
npm install
cp .env.example .env      # fill in DERIV_APP_ID and DERIV_ACCESS_TOKEN
npm run build
npm start
```

Open <http://localhost:8080> for the dashboard.

Get an API token at <https://app.deriv.com/account/api-token>. It needs the
**Read** and **Trade** scopes. Create a token against your *demo* account first.

---

## Configuration

Every variable, its default, and what it does is documented in `.env.example`.
The ones that matter most:

| Variable | Default | Meaning |
|---|---|---|
| `ENABLE_REAL_TRADING` | `false` | Master switch. `false` = dry run. |
| `DERIV_ACCOUNT_TYPE` | `demo` | Asserted against the real account. Mismatch = refuse to start. |
| `MIN_SIGNAL_SCORE` | `70` | Confluence score (0–100) required to consider a trade. |
| `RISK_PER_TRADE_PERCENT` | `1` | Stake as a % of balance. On a binary contract the stake *is* the max loss. |
| `DAILY_LOSS_LIMIT_PERCENT` | `5` | Halt when down this much from the day's opening balance. |
| `MAX_DRAWDOWN_PERCENT` | `10` | Halt when down this much from the all-time peak balance. |
| `MAX_CONSECUTIVE_LOSSES` | `3` | Halt after this many losses in a row. |
| `SCAN_MARKETS` | `synthetic_index,forex` | Auto-discovery groups. `SCAN_SYMBOLS` overrides with an exact list. |
| `ADMIN_API_KEY` | *(unset)* | Required to enable `/control/*`. Unset = those endpoints return 404. |
| `WEBHOOK_URL` | *(unset)* | Signals/trades/halts POSTed here as JSON. |

---

## The signal model

Direction is decided **first** by the EMA trend stack (fast > slow > trend for a
Rise, inverted for a Fall). If there is no clean stack the symbol is skipped as
ranging — no trade. Every other component can only *confirm* that direction; a
component that disagrees earns zero rather than flipping the trade.

| Component | Weight | What earns credit |
|---|---:|---|
| Trend | 30 | EMA separation measured in ATR units, plus trend-EMA slope |
| Momentum | 20 | RSI confirming direction, with **no credit** when overbought/oversold (exhaustion) |
| Location | 20 | Price near the fast EMA; credit decays to zero as price extends past ~2 ATR |
| Structure | 20 | Engulfing candle = full credit; strong directional body = partial, minus a penalty for an opposing wick |
| Volatility | 10 | ATR in a tradeable band; both dead and erratic markets lose credit |

The still-forming candle is dropped before scoring, so a bar cannot repaint a
signal after the fact. Each component's contribution and a plain-language reason
are returned in the API and shown on the dashboard — the score is never an
unexplained number.

Only the **single highest-scoring** signal per scan is acted on. Firing every
qualifying signal at once is how a bot ends up holding a dozen correlated
positions.

---

## API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Railway healthcheck. Always 200 while the process serves; upstream state is in the body. |
| `GET` | `/` | Live dashboard |
| `GET` | `/api/status` | Account, trading mode, risk state, limits, scanner state, stats |
| `GET` | `/api/signals?limit=&minScore=` | Recently scored signals with component breakdowns |
| `GET` | `/api/trades?limit=` | Trade history and win/loss stats |
| `GET` | `/api/scans?limit=` | Per-scan summaries |
| `GET` | `/api/symbols` | Symbols currently being scanned |
| `POST` | `/control/halt` | Stop trading. Requires `Authorization: Bearer $ADMIN_API_KEY` |
| `POST` | `/control/resume` | Clear a halt. Same auth |
| `POST` | `/control/scan` | Trigger a scan immediately. Same auth |

`/health` is deliberately shallow. If it reported unhealthy whenever Deriv was
unreachable, a brief upstream blip would make Railway kill a container that is
already reconnecting correctly.

---

## Deploying to Railway

1. Push this repo to GitHub.
2. In Railway: **New Project → Deploy from GitHub repo**.
3. Set the variables from `.env.example` in the Railway variable editor.
   Do not commit real credentials.
4. Railway auto-detects Node. The settings that must match:
   - **Start command:** `npm run start:prod`
   - **Healthcheck path:** `/health`
5. Generate a domain and open it for the dashboard.

### A note on the state file

Risk state persists to `.bot-state.json` in the working directory. Railway
containers have ephemeral filesystems, so a **redeploy** resets daily counters
and clears a tripped breaker. Within a container's life (including crash
restarts) the state survives, which is the case that matters most. If you want
breakers that survive redeploys, attach a Railway volume and point `STATE_FILE`
at a path inside it.

---

## Development

```bash
npm run dev        # watch mode
npm test           # unit tests (indicators + risk manager)
npm run typecheck  # tsc --noEmit
```

The test suite covers indicator correctness against known-value cases
(constant series, monotonic series, zero-range candles, gap handling) and every
risk breaker including persistence across a simulated restart. Run it before
changing anything in `src/risk/` or `src/indicators/`.

---

## Project layout

```
src/
  index.ts              startup, shutdown, retry, account assertion
  config.ts             env parsing + validation (fails closed)
  logger.ts             structured JSON logs with secret redaction
  deriv/client.ts       WebSocket client: auth, req_id correlation, ping, reconnect
  indicators/           EMA, RSI (Wilder), ATR (Wilder), swings, candle anatomy
  strategy/scorer.ts    the confluence model
  risk/manager.ts       position sizing, circuit breakers, persistence
  trading/executor.ts   proposal → buy → settlement tracking; the real-money gate
  scanner.ts            the scan loop and symbol discovery
  server/api.ts         REST + control endpoints
  server/dashboard.ts   self-contained dashboard (no CDN, no browser storage)
```

Dashboard colors come from a CVD-validated palette; the meter track is
deliberately neutral rather than a step of the fill's ramp, because the fill's
hue encodes severity and a colored track would read as a second data segment.

## License

MIT
