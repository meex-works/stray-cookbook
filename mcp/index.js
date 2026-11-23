#!/usr/bin/env node
// Stray MCP server: the Stray API (https://stray.fi/docs) as read-only tools for Claude, Cursor or any MCP client.
// Runs over stdio. Needs STRAY_API_KEY (a key from https://stray.fi/console). Every tool call is one API call.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE = (process.env.STRAY_BASE_URL || "https://stray.fi/v1").replace(/\/+$/, "");
const KEY = process.env.STRAY_API_KEY;
const CORE = ["BTC", "ETH", "HYPE", "SOL", "XRP", "DOGE", "BNB", "SUI"];
const HOUR = 3600e3;
const MAX_ROWS = 200;

async function get(path, params = {}) {
  if (!KEY) throw new Error("STRAY_API_KEY is not set. Make a key at https://stray.fi/console and add it to this server's env.");
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  const res = await fetch(url, { headers: { authorization: `Bearer ${KEY}`, "user-agent": "stray-mcp/0.1" } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const wait = res.headers.get("retry-after");
    throw new Error(`Stray API ${res.status}: ${body.error || res.statusText}${wait ? ` Retry after ${wait} s.` : ""}`);
  }
  return body;
}

// Time series come back as {fields, rows: [[...]]} or {rows: [{...}]}. Turn them into at most MAX_ROWS objects,
// one per `step` minutes, newest last, so a model reads named values and the reply stays small.
function series(body, { step, keep = MAX_ROWS } = {}) {
  const { fields, rows = [], ...rest } = body;
  let objs = fields ? rows.map((r) => Object.fromEntries(fields.map((f, i) => [f, r[i]]))) : rows;
  if (step) {
    const seen = new Set();
    objs = objs.filter((o) => { const b = Math.floor(o.t / (step * 60e3)); if (seen.has(b)) return false; seen.add(b); return true; });
  }
  const shown = objs.slice(-keep).map((o) => ({ ...o, time: new Date(o.t).toISOString() }));
  return { ...rest, rows: shown, rows_total: objs.length, ...(objs.length > shown.length ? { rows_note: `Showing the newest ${shown.length}. Use a larger step for a longer span.` } : {}) };
}

const span = (hours) => { const to = Date.now(); return { from: to - hours * HOUR, to }; };
const coreCoin = z.enum(CORE).describe("A core market: " + CORE.join(", "));
const anyCoin = z.string().describe('A core market (e.g. "BTC") or a HIP-3 market by its full name (e.g. "xyz:NVDA"; see stray_markets)');
const hours = (def, max) => z.number().min(0.2).max(max).default(def).describe(`How many hours back, up to ${max}. Default ${def}.`);
const step = (def) => z.number().int().min(1).max(1440).default(def).describe(`Minutes between rows. Default ${def}.`);

const server = new McpServer(
  { name: "stray", version: "0.1.0" },
  {
    instructions:
      "Stray records Hyperliquid perp markets: order-book depth, funding, open interest, flow, whale positioning and liquidation levels, " +
      "plus the same markets on Binance, Bybit and OKX. Core markets: " + CORE.join(", ") + ". " +
      "Fractions are decimals (-0.1379 = -13.79%); times are UTC; USD values are US dollars. " +
      "Everything describes the past or the present. Nothing here is a forecast or advice, so don't present it as one. " +
      "Each tool call costs one call from the user's monthly quota; prefer stray_draw for a quick read of the whole market.",
  },
);

function tool(name, title, description, inputSchema, run) {
  server.registerTool(name, { title, description, inputSchema, annotations: { readOnlyHint: true, openWorldHint: true } }, async (args) => {
    try { return { content: [{ type: "text", text: JSON.stringify(await run(args)) }] }; }
    catch (e) { return { content: [{ type: "text", text: e.message }], isError: true }; }
  });
}

tool("stray_markets", "Markets", "The markets Stray covers, the HIP-3 (builder-deployed) markets it records, and when recording began.", {},
  () => get("/markets"));

tool("stray_draw", "The Draw", "The Draw: how tense a market is right now against its own history, 0 (calm) to 100 (stressed), with its band " +
  "(Sheathed, Resting, Hand on hilt, Drawing, Drawn). Without a coin: the whole market, each core market's reading and their weights. " +
  "With a coin: the seven components (vol, thin, crowding, funding, liquidation, positioning, flow) and the inputs behind them. Updated every 10 minutes.",
  { coin: coreCoin.optional().describe("A core market. Leave out for the whole market."), hours: hours(24, 24 * 30) },
  async ({ coin, hours: h }) => {
    const b = await get(coin ? `/draw/${coin}` : "/draw", { ...span(h), step: h > 72 ? 1440 : 60 });
    const { history, history_step_min, ...rest } = b;
    return { ...rest, history: series({ fields: ["t", "draw"], rows: history }).rows.map(({ time, draw }) => ({ time, draw })), history_step_min };
  });

tool("stray_ranges", "Past ranges", "How far the market moved over past windows of the same length: percentiles (p10 to p90) of the move, and where the " +
  "latest window sits. Past ranges, not a forecast.", { coin: coreCoin, window: z.union([1, 3, 7, 14, 30, 60, 90].map((n) => z.literal(n))).default(7).describe("Days: 1, 3, 7, 14, 30, 60 or 90. Default 7.") },
  ({ coin, window }) => get(`/ranges/${coin}`, { window }));

tool("stray_depth", "Order-book depth", "US dollars resting on each side of the live Hyperliquid book within ±0.5%, ±1% and ±2% of mid. Updated every 5 seconds.",
  { coin: anyCoin }, ({ coin }) => get(`/depth/${coin}`));

tool("stray_funding", "Funding", "Funding on Hyperliquid (hourly, since listing), Binance or Bybit (every 8 hours). The summary ranks the latest rate " +
  "against all history, with the annualized rate; recent rows follow.",
  { coin: coreCoin, venue: z.enum(["hyperliquid", "binance", "bybit"]).default("hyperliquid"), hours: hours(24, 24 * 366) },
  async ({ coin, venue, hours: h }) => series(await get(`/funding/${coin}`, { venue, ...span(h) }), { keep: 48 }));

tool("stray_conditional", "When funding was like today", "Every day since 2023 is put into one of ten bands by its average hourly funding. Returns " +
  "today's band and the spread of moves over the next N days after past days in that band, beside all days. Past, not a forecast.",
  { coin: coreCoin, horizon: z.union([1, 3, 7, 14, 30].map((n) => z.literal(n))).default(7).describe("Days ahead: 1, 3, 7, 14 or 30. Default 7.") },
  ({ coin, horizon }) => get(`/conditional/${coin}`, { horizon }));

tool("stray_crowding", "Crowding", "Hyperliquid open interest in USD divided by USD resting within ±1% of mid: dollars of positions per dollar of book. " +
  "The latest reading's percentile ranks it against the window.", { coin: coreCoin, hours: hours(168, 168) },
  async ({ coin, hours: h }) => series(await get(`/crowding/${coin}`, span(h)), { step: 60, keep: 24 }));

tool("stray_profile", "The typical day", "Median depth within ±1%, spread and Hyperliquid volume per 10 minutes for each hour of the day (UTC), over the " +
  "last N days. Shows when books thin out.", { coin: coreCoin, days: z.number().int().min(1).max(30).default(7) },
  ({ coin, days }) => get(`/profile/${coin}`, { days }));

tool("stray_venues", "Hyperliquid vs Binance, Bybit, OKX", "The same market on four venues side by side: USD within ±0.05% to ±2% of each venue's mid, " +
  "spread, funding and open interest, and Hyperliquid's share of the four venues' depth in the tightest bands.", { coin: coreCoin, hours: hours(1, 168), step: step(10) },
  async ({ coin, hours: h, step: s }) => series(await get(`/venues/${coin}`, { ...span(h), step: s }), { keep: 3 }));

tool("stray_flow", "Trade flow", "Hyperliquid volume by aggressor side in USD, number of buys and sells, the largest trade, and liquidations on Binance " +
  "and Bybit by side (liq_long_usd = longs closed).", { coin: coreCoin, hours: hours(6, 168), step: step(60) },
  async ({ coin, hours: h, step: s }) => series(await get(`/flow/${coin}`, { ...span(h), step: s })));

tool("stray_positioning", "Binance positioning", "Binance's open interest, share of accounts long, top traders' long share and taker buy/sell volume, " +
  "every 5 minutes (shown hourly).", { coin: coreCoin, hours: hours(24, 24 * 31) },
  async ({ coin, hours: h }) => series(await get(`/positioning/${coin}`, span(h)), { step: 60 }));

tool("stray_whales", "Whale positioning", "Open perp positions of the top 1,500 Hyperliquid accounts by account value, totalled per coin: long, short and " +
  "net USD, accounts on each side, size-weighted leverage, and HLP's net position. Totals only; no wallets.", { coin: coreCoin, hours: hours(24, 24 * 31), step: step(60) },
  async ({ coin, hours: h, step: s }) => series(await get(`/whales/${coin}`, { ...span(h), step: Math.max(10, s) })));

tool("stray_liqmap", "Liquidation map", "Where the top Hyperliquid accounts' positions get liquidated, by distance from the mark, in USD of position value, " +
  "grouped 0-2%, 2-5%, 5-10%, 10-20% and 20-50% below and above. A sample of the largest accounts, not every position.",
  { coin: coreCoin, detail: z.boolean().default(false).describe("Also return the 0.5% bands from -50% to +50%.") },
  async ({ coin, detail }) => { const { map, ...b } = await get(`/liqmap/${coin}`); return detail ? { ...b, map } : b; });

tool("stray_implied", "Implied vs realized volatility", "Deribit's implied volatility index beside realized volatility from Hyperliquid daily closes, " +
  "the one-sigma moves each implies over 1, 7 and 30 days, and where implied ranks against every day since 2021.", { coin: z.enum(["BTC", "ETH"]) },
  async ({ coin }) => { const b = await get(`/implied/${coin}`); return { ...series(b, { keep: 7 }) }; });

tool("stray_basis", "HYPE spot-perp basis", "HYPE's perp mark against HYPE/USDC spot on Hyperliquid, in basis points (positive = perp above spot), with " +
  "funding, circulating supply and spot volume.", { hours: hours(24, 24 * 31), step: step(60) },
  async ({ hours: h, step: s }) => series(await get("/basis/HYPE", { ...span(h), step: s })));

tool("stray_correlation", "Correlation", "Correlation of daily returns between the core markets over 30, 90 or 180 days, as a matrix in the order of coins.",
  { window: z.union([30, 90, 180].map((n) => z.literal(n))).default(30) }, ({ window }) => get("/correlation", { window }));

tool("stray_liquidity", "Top of book", "Ten-minute medians of the top of the Hyperliquid book: spread in basis points and USD in the top 5 and top 20 levels " +
  "on each side.", { coin: coreCoin, hours: hours(24, 24 * 366) },
  async ({ coin, hours: h }) => series(await get(`/liquidity/${coin}`, span(h)), { step: 60 }));

tool("stray_history", "Stray's record", "Stray's own minute-by-minute record of a market: mark, oracle, hourly funding, open interest in coins, and USD " +
  "resting within ±0.05% to ±2% of mid on each side.", { coin: anyCoin, hours: hours(24, 168), step: step(60) },
  async ({ coin, hours: h, step: s }) => series(await get(`/history/${coin}`, { ...span(h), step: s })));

await server.connect(new StdioServerTransport());
