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
- 📈 Chainlink BTC/USD on-chain oracle (settlement parity) with Binance spot fallback
- 📦 Open positions viewer with inline Sell/Close at best bid
- 💾 Atomic, persisted state (`data/state.json`)

## Setup

```bash
npm install
cp .env.example .env   # fill in your values
npm run dev
```

Required env: `TELEGRAM_BOT_TOKEN`, `PREDICTFUN_API_KEY` (mainnet).
Keep `DRY_RUN=true` until you trust the setup.

### Zero-setup wallet (optional)

`PREDICTFUN_PRIVATE_KEY` is legacy/optional — it only backs an extra owner
wallet. Every Telegram user who `/start`s the bot gets their OWN fresh BSC
trading wallet instantly (no approval). Keys are stored AES-256-GCM
encrypted in `data/accounts.json`; the encryption key comes from
`WALLET_MASTER_KEY` or the auto-generated `data/master.key`
(**back it up — without it member keys cannot be decrypted**).

Members can:
- export their own key via ⚙️ Settings → 🔐 Export Private Key or `/export`
  (private chat only, inline confirm, auto-deletes after 90s)
- withdraw USDT via 🏦 Wallet → 💸 Withdraw or `/withdraw` (paste address →
  amount or `all` → Confirm → BSCScan TX link)

### Multi-user (per-user wallets, max 10 members)

Anyone can `/start` — their account + wallet is auto-created (up to
`MAX_USERS`, default 10). Set `JOIN_CODE` to make joining invite-only
(`/start <code>`). No admin approval needed. Each member has their own
balance, positions, orders, approvals, deposit notifications, trade history
and per-member daily loss cap (`USER_DAILY_LOSS_LIMIT_USDT`).

Admins (from `TELEGRAM_ALLOWED_USERS`) can run:
- `/users` — member list, slots, per-member PnL
- `/kick <id>` — block access (wallet + funds untouched, no auto re-join)
- `/unban <id>` — restore blocked access
- `/reset` — reset the shared circuit breaker

Also included: incoming-deposit notifications (wallet balances are polled
every 30s) and deep links (Predict.fun market/portfolio, BSCScan) on every
trade/round/wallet message.

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
│   ├── chainlinkPrice.ts        # settlement-parity on-chain oracle price
│   ├── btcPrice.ts              # Binance WS fallback
│   ├── depositWatcher.ts        # per-member incoming-funds notifications
│   └── autoServices.ts          # notifications, settlement, auto-redeem,
│                                # dry-run settlement simulator, fill tracking
├── execution/risk.ts            # trades, exposure, circuit breaker
├── users/                       # registry, encrypted per-user wallets, runtime
├── exchanges/predictfun/        # REST API + SDK order signer
└── utils/                       # pino logger, shared RPC provider, atomic state store
```

## Safety notes

- Use a **dedicated hot wallet** holding only trading funds — never your main wallet.
- Member keys are encrypted at rest; the master key (`WALLET_MASTER_KEY` or
  `data/master.key`) must be backed up and kept off the server's public paths.
  Restrict `.env` file permissions (the bot warns on startup).
- Never export a private key in a group chat — `/export` and `/withdraw` are
  private-chat only by design.
- Unfilled limit orders are tracked and reconciled against on-chain positions;
  exposure only counts confirmed fills.
- **Before enabling live trading**, place one small order per member wallet:
  every member signs with their own key, but the REST API key
  (`PREDICTFUN_API_KEY`) is shared — confirm the API accepts orders for each
  wallet (use `PREDICTFUN_TESTNET=true` first).
