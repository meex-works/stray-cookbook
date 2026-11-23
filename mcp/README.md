# Stray MCP server

The [Stray API](https://stray.fi/docs) as read-only MCP tools, over stdio. Node 18 or later.

```sh
npm install
STRAY_API_KEY=stray_... npm test     # starts the server, lists the tools, calls each once (about 18 calls)
```

Setup for Claude Code, Claude Desktop and Cursor is in the [main README](../README.md#use-stray-with-ai).

| Tool | Returns |
|---|---|
| `stray_draw` | The Draw, 0 (calm) to 100 (stressed): the whole market with each core market, or one market with its seven components and inputs |
| `stray_depth` | USD within ±0.5%, ±1% and ±2% of mid on the live book (core or HIP-3 markets) |
| `stray_profile` | The typical day: median depth, spread and volume for each UTC hour |
| `stray_crowding` | Open interest per dollar of book within ±1%, with the latest percentile |
| `stray_venues` | Hyperliquid, Binance, Bybit and OKX side by side, and Hyperliquid's share of depth |
| `stray_funding` | Funding on Hyperliquid, Binance or Bybit, ranked against all history |
| `stray_conditional` | Today's funding decile and the moves that followed past days in it |
| `stray_ranges` | Percentiles of past moves over 1 to 90 days, and where the latest sits |
| `stray_flow` | Volume by aggressor side, largest trade, liquidations by side |
| `stray_positioning` | Binance open interest, long/short accounts, top traders, taker volume |
| `stray_whales` | Totals of the top 1,500 Hyperliquid accounts' positions, and HLP |
| `stray_liqmap` | Where those positions get liquidated, by distance from the mark |
| `stray_implied` | Deribit implied volatility beside realized (BTC, ETH) |
| `stray_basis` | HYPE perp against spot, in basis points |
| `stray_correlation` | Correlation of daily returns between the core markets |
| `stray_liquidity` | Spread and USD in the top 5 and top 20 levels |
| `stray_history` | Stray's minute record: mark, oracle, funding, open interest, depth bands |
| `stray_markets` | The markets covered, and when recording began |

Time series come back as named rows, newest last, at most 200 (fewer where rows are wide). Ask for a larger `step`
to cover a longer span. The live stream (`/v1/stream`, Pro) isn't a tool: it's an open connection, not a question.

`STRAY_BASE_URL` overrides `https://stray.fi/v1`.
