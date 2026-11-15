# Predict.fun BTC 5M Telegram Bot

Telegram bot for trading **Predict.fun 5-minute BTC Up/Down** prediction rounds on BNB Chain.

## Features

- 🖥️ Live round dashboard (timer, lock price, odds, BTC trend) in Telegram
- ⚡ Quick bets: `/up 10`, `/down 10`, or `up 5 45` ($5 UP @ 45¢ limit)
- 🧪 **DRY RUN mode** with a full **settlement simulator** — resolved rounds are
  scored from the market's start/end price, so PnL, win rate and the daily loss
  circuit breaker all work without real orders
- 🛡️ Risk controls: max bet, daily loss circuit breaker (persisted across
  restarts), lock-guard window, balance pre-flight
- 🔔 Round start / lock warnings, auto-redeem of winning positions
- 📈 Pyth oracle price (settlement parity) with Binance spot fallback
- 📦 Open positions viewer with inline Sell/Close at best bid
- 💾 Atomic, persisted state (`data/state.json`)

## Setup

```bash
npm install
cp .env.example .env   # fill in your values
npm run dev
```

Required env: `TELEGRAM_BOT_TOKEN`, `PREDICTFUN_API_KEY` (mainnet),
`PREDICTFUN_PRIVATE_KEY`. Keep `DRY_RUN=true` until you trust the setup.

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Run with tsx + hot reload |
| `npm run build` | Compile TypeScript |
| `npm start` | Run compiled build |
| `npm run typecheck` | Type-check only |
| `npm test` | Pure-logic smoke tests (no network) |

## Architecture

```
src/
├── index.ts                     # bootstrap, graceful shutdown, crash handlers
├── config/index.ts              # strict env parsing
├── bot/                         # grammy handlers, keyboards, bet-text parser
├── services/
│   ├── roundWatcher.ts          # active round + odds sync (1s tick)
│   ├── pythPrice.ts             # settlement-parity oracle price
│   ├── btcPrice.ts              # Binance WS fallback
│   └── autoServices.ts          # notifications, settlement, auto-redeem,
│                                # dry-run settlement simulator, fill tracking
├── execution/risk.ts            # trades, exposure, circuit breaker
├── exchanges/predictfun/        # REST API + SDK order signer
└── utils/                       # pino logger, atomic state store
```

## Safety notes

- Use a **dedicated hot wallet** holding only trading funds — never your main wallet.
- The private key lives in `.env`; restrict file permissions (the bot warns on startup).
- Unfilled limit orders are tracked and reconciled against on-chain positions;
  exposure only counts confirmed fills.
