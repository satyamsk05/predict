import WebSocket from 'ws';
import { logger } from '../utils/logger.js';

export interface BtcPriceState {
  currentPrice: number;
  lastUpdated: number;
  change24h: number;
}

class BtcPriceService {
  private price: number = 0;
  private change24h: number = 0;
  private lastUpdated: number = 0;
  private ws: WebSocket | null = null;
  private isConnected: boolean = false;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private intentionalClose = false;

  constructor() {
    this.connectWs();
    // Periodic fallback in case WebSocket gets quiet
    setInterval(() => this.fallbackFetch(), 15000);
  }

  private connectWs() {
    try {
      this.intentionalClose = false;
      // Close any previous socket before opening a new one
      if (this.ws) {
        try {
          this.intentionalClose = true;
          this.ws.removeAllListeners();
          this.ws.close();
        } catch {
          // ignore
        }
        this.ws = null;
        this.intentionalClose = false;
      }

      this.ws = new WebSocket('wss://stream.binance.com:9443/ws/btcusdt@ticker');

      this.ws.on('open', () => {
        this.isConnected = true;
        logger.info('Connected to Binance BTC/USDT live price stream');
      });

      this.ws.on('message', (data: WebSocket.RawData) => {
        try {
          const parsed = JSON.parse(data.toString());
          // 'c' is the last price in ticker stream
          if (parsed.c) {
            this.price = parseFloat(parsed.c);
            this.change24h = parseFloat(parsed.P || '0');
            this.lastUpdated = Date.now();
          }
        } catch {
          // ignore malformed frame
        }
      });

      this.ws.on('close', () => {
        this.isConnected = false;
        if (!this.intentionalClose) {
          this.scheduleReconnect();
        }
      });

      this.ws.on('error', (err) => {
        logger.warn({ err: err.message }, 'Binance WebSocket error, reconnecting...');
        this.isConnected = false;
        try {
          this.ws?.close();
        } catch {
          // ignore
        }
      });
    } catch (e) {
      logger.error({ err: e }, 'Failed to initiate Binance WebSocket');
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimeout) return;
    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      this.connectWs();
    }, 5000);
  }

  private async fallbackFetch() {
    // If WS hasn't received update in 10s, fetch via REST
    if (Date.now() - this.lastUpdated > 10000 || this.price === 0) {
      try {
        const res = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT', {
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) {
          const data = (await res.json()) as { price: string };
          const price = parseFloat(data.price);
          if (Number.isFinite(price) && price > 0) {
            this.price = price;
            this.lastUpdated = Date.now();
          }
        }
      } catch {
        // quiet error
      }
    }
  }

  public getPrice(): number {
    if (this.price <= 0) return 0;
    // Never present a stale print as a live price — 5m rounds move fast and a
    // frozen feed would silently mis-score the trend / lock price.
    if (this.lastUpdated > 0 && Date.now() - this.lastUpdated > 60_000) return 0;
    return this.price;
  }

  public getState(): BtcPriceState {
    return {
      currentPrice: this.price,
      lastUpdated: this.lastUpdated,
      change24h: this.change24h,
    };
  }
}

export const btcPriceService = new BtcPriceService();
