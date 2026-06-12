---
type: "reference"
file: "alpaca-rest"
date: "2026-06-12"
summary: "Alpaca PAPER REST quick-reference for the agent. Read scope only for now; ordering shown for Project-2 execution."
---

# Alpaca PAPER — REST quick-reference

PAPER endpoint only. Keys from env vars; never print them.
- Base (trading): `$ALPACA_BASE_URL` = `https://paper-api.alpaca.markets`
- Data host: `https://data.alpaca.markets`
- Auth headers (every call): `APCA-API-KEY-ID: $ALPACA_API_KEY`, `APCA-API-SECRET-KEY: $ALPACA_API_SECRET`

## Read (use these constantly)
- Account: `GET {BASE}/v2/account` → equity, cash, buying_power, daytrade_count.
- Positions: `GET {BASE}/v2/positions`
- Orders: `GET {BASE}/v2/orders?status=all&limit=100`
- Latest quote: `GET https://data.alpaca.markets/v2/stocks/{SYM}/quotes/latest`
- Crypto quote: `GET https://data.alpaca.markets/v1beta3/crypto/us/latest/quotes?symbols=BTC/USD,ETH/USD`

## Place a trade (PAPER execution — Project 2's job)
- Market/limit order:
```
curl -s -X POST "$ALPACA_BASE_URL/v2/orders" \
  -H "APCA-API-KEY-ID: $ALPACA_API_KEY" -H "APCA-API-SECRET-KEY: $ALPACA_API_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"symbol":"AAPL","qty":10,"side":"buy","type":"limit","limit_price":195.00,"time_in_force":"day"}'
```
- Trailing-stop order (set on every entry, ~18% paper default):
```
-d '{"symbol":"AAPL","qty":10,"side":"sell","type":"trailing_stop","trail_percent":"18","time_in_force":"gtc"}'
```
- Close a position: `DELETE {BASE}/v2/positions/{SYM}`
- Cancel an order: `DELETE {BASE}/v2/orders/{id}`

## Verify before trusting it
Fetch `/v2/account` and `/v2/positions`, print equity + positions, and match the Alpaca dashboard. If they match, the wiring is correct.

> Safety: while the LIVE profile is locked, only `$ALPACA_BASE_URL = paper-api...` is permitted. Never point these at a live endpoint.
