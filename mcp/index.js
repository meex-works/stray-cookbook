#!/usr/bin/env node
// Stray MCP server: the Stray API (https://stray.fi/docs) as read-only tools for Claude, Cursor or any MCP client.
// Runs over stdio. Needs STRAY_API_KEY (a key from https://stray.fi/console). Most tools make one API call; the composed
// tools (stray_book_check, stray_unusual, stray_brief) say in their description how many they make, and report it.
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const VERSION = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version;
const BASE = (process.env.STRAY_BASE_URL || "https://stray.fi/v1").replace(/\/+$/, "");
if (!/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(BASE + "/")) throw new Error("STRAY_BASE_URL must be https:// (or http://localhost for testing).");
const KEY = process.env.STRAY_API_KEY;
const CORE = ["BTC", "ETH", "HYPE", "SOL", "XRP", "DOGE", "BNB", "SUI"];
const HOUR = 3600e3;
const MAX_ROWS = 200;
const BANDS = ["0.5%", "1%", "2%"];
const LIQ_SAMPLE = "the top 1,500 Hyperliquid accounts by account value; not every position";

// One API client per tool call, so a composed tool can report how many calls it made. Slow-moving reads (the hour
// profile, crowding, the liquidation map, the Draw) are cached for 60 s across calls; a cache hit costs no quota.
const CACHE = new Map();
const CACHED = /^\/(profile|crowding|liqmap|draw)(\/|$)/;
function client() {
  const api = { calls: 0 };
  api.get = async (path, params = {}) => {
    if (!KEY) throw new Error("STRAY_API_KEY is not set. Make a key at https://stray.fi/console and add it to this server's env.");
    const url = new URL(BASE + path);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    const base = new URL(BASE);
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname + "/")) throw new Error("Refused: that request would leave the Stray API.");
    const hit = CACHED.test(path) && CACHE.get(url.href);
    if (hit && Date.now() - hit.at < 60e3) return hit.body;
    api.calls++;
    const res = await fetch(url, { headers: { authorization: `Bearer ${KEY}`, "user-agent": `stray-mcp/${VERSION}` } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const wait = res.headers.get("retry-after");
      throw new Error(`Stray API ${res.status}: ${body.error || res.statusText}${wait ? ` Retry after ${wait} s.` : ""}`);
    }
    if (CACHED.test(path)) CACHE.set(url.href, { at: Date.now(), body });
    return body;
  };
  return api;
}

const iso = (t) => (Number.isFinite(t) ? new Date(t).toISOString() : null);
const round = (x, d = 4) => (Number.isFinite(x) ? Number(x.toFixed(d)) : null);
const sig = (x, s = 6) => (Number.isFinite(x) ? Number(x.toPrecision(s)) : null);
const sum = (xs) => xs.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);

// Time series come back as {fields, rows: [[...]]} or {rows: [{...}]}. Turn them into at most `keep` objects,
// one per `step` minutes, newest last, so a model reads named values and the reply stays small. `all` keeps every
// row (before trimming) for summaries.
function series(body, { step, keep = MAX_ROWS } = {}) {
  const { fields, rows = [], ...rest } = body;
  let objs = fields ? rows.map((r) => Object.fromEntries(fields.map((f, i) => [f, r[i]]))) : rows;
  if (step) {
    const seen = new Set();
    objs = objs.filter((o) => { const b = Math.floor(o.t / (step * 60e3)); if (seen.has(b)) return false; seen.add(b); return true; });
  }
  const shown = objs.slice(-keep).map((o) => ({ ...o, time: iso(o.t) }));
  const out = { ...rest, rows: shown, rows_total: objs.length, ...(objs.length > shown.length ? { rows_note: `Showing the newest ${shown.length}. Use a larger step for a longer span.` } : {}) };
  Object.defineProperty(out, "all", { value: objs, enumerable: false });
  return out;
}

// The window a series tool reads: `hours` back from `end` (default now). A window that ends before the record for
// that series starts is an error that names the start; one in the future is refused.
const endArg = z.iso.datetime({ offset: true }).optional()
  .describe("End of the window, ISO 8601 UTC (e.g. 2026-11-25T14:00:00Z). Default now. Set it to read a past window.");
function span(hours, end) {
  const now = Date.now();
  let to = Math.ceil(now / 60e3) * 60e3;                   // "now", rounded up to the minute so repeat reads can share the cache
  if (end) {
    to = Date.parse(end);
    if (!Number.isFinite(to)) throw new Error("end must be an ISO 8601 time, e.g. 2026-11-25T14:00:00Z.");
    if (to > now + 60e3) throw new Error("end is in the future. Stray records what markets have done.");
  }
  return { from: Math.round(to - hours * HOUR), to: Math.round(to) };
}
const windowOf = (sp) => ({ from: iso(sp.from), to: iso(sp.to) });
function checkEmpty(out, sp) {
  if (out.rows_total) return out;
  const since = Date.parse(out.recording_since ?? "");
  if (Number.isFinite(since) && sp.to < since) throw new Error(`That window ends before Stray's record of it starts (${out.recording_since}).`);
  return { ...out, rows_note: "No rows in this window." };
}

const coreCoin = z.enum(CORE).describe("A core market: " + CORE.join(", "));
// Market names only: letters and digits, optionally "dex:NAME". Anything path-shaped never reaches the URL.
const anyCoin = z.string().regex(/^[A-Za-z0-9]{1,20}(:[A-Za-z0-9]{1,30})?$/, "a market name like BTC or xyz:NVDA")
  .describe('A core market (e.g. "BTC") or a HIP-3 market by its full name (e.g. "xyz:NVDA"; see stray_markets)');
const hours = (def, max) => z.number().min(0.2).max(max).default(def).describe(`How many hours back, up to ${max}. Default ${def}.`);
const step = (def) => z.number().int().min(1).max(1440).default(def).describe(`Minutes between rows. Default ${def}.`);

const server = new McpServer(
  { name: "stray", version: VERSION },
  {
    instructions:
      "Stray records Hyperliquid perp markets: order-book depth, funding, open interest, flow, whale positioning and liquidation levels, " +
      "plus the same markets on Binance, Bybit and OKX. Core markets: " + CORE.join(", ") + ". " +
      "Where to start: 'how crowded is the exit', 'can the book take $X' or 'is the book thin' → stray_book_check; " +
      "'is this move unusual' → stray_unusual; 'what is stretched' → stray_brief, then stray_draw with a coin; " +
      "'are positions being opened or closed' → stray_oi_change; 'is the funding gap between venues real' → stray_funding_venues; " +
      "'what happened during that move' → stray_history, stray_flow or stray_liquidity with `end`. " +
      "Every result starts with as_of and source: give the time of every number you quote and what it is compared with. " +
      "Fractions are decimals (-0.1379 = -13.79%); times are UTC; USD values are US dollars. " +
      "Everything describes the past or the present. Nothing here is a forecast or advice: if asked what a price will do, " +
      "say Stray records what markets have done and give the current readings. " +
      "Most tools cost one call from the user's monthly quota; the composed tools say how many they make.",
  },
);

// Every result starts with when it is from and where it comes from, then the window and the norm where there is one.
function envelope(r, source) {
  const { as_of, source: own, window, norm, ...rest } = r;
  const rows = Array.isArray(rest.rows) ? rest.rows : null;
  const at = as_of ?? (Number.isFinite(rest.t) ? iso(rest.t) : rows?.length ? rows[rows.length - 1].time : new Date().toISOString());
  const src = typeof source === "function" ? source(r) : (own && typeof own === "string" && own.length > 8 ? own : source);
  return { as_of: at, source: src, ...(window ? { window } : {}), ...(norm ? { norm } : {}), ...rest };
}

function tool(name, title, description, inputSchema, source, run) {
  server.registerTool(name, { title, description, inputSchema, annotations: { readOnlyHint: true, openWorldHint: true } }, async (args) => {
    const api = client();
    try {
      const out = envelope(await run(args, api), source);
      if (api.calls > 1) out.api_calls = api.calls;
      return { content: [{ type: "text", text: JSON.stringify(out) }] };
    } catch (e) { return { content: [{ type: "text", text: e.message }], isError: true }; }
  });
}

// ── single-endpoint tools ───────────────────────────────────────────────────────────────────────────────────────

tool("stray_markets", "Markets", "The markets Stray covers, the HIP-3 (builder-deployed) markets it records, and when recording began.", {},
  "Stray", (_, api) => api.get("/markets"));

tool("stray_draw", "The Draw", "The Draw: how tense a market is against its own history, 0 (calm) to 100 (stressed), with its band " +
  "(Sheathed, Resting, Hand on hilt, Drawing, Drawn). Without a coin: the whole market, each core market's reading and their weights. " +
  "With a coin: the seven components (vol, thin, crowding, funding, liquidation, positioning, flow) and the inputs behind them. " +
  "Start here for 'what is stretched on this market'. Components are measured conditions, each ranked against its own history, " +
  "not a call on what comes next. Updated every 10 minutes; with `end`, the reading as of that time.",
  { coin: coreCoin.optional().describe("A core market. Leave out for the whole market."), hours: hours(24, 24 * 30), end: endArg },
  "Stray's Draw, computed every 10 minutes from the record",
  async ({ coin, hours: h, end }, api) => {
    const sp = span(h, end);
    const b = await api.get(coin ? `/draw/${coin}` : "/draw", { ...sp, step: h > 72 ? 1440 : 60 });
    const { history, history_step_min, ...rest } = b;
    return { ...rest, window: windowOf(sp), history: series({ fields: ["t", "draw"], rows: history }).rows.map(({ time, draw }) => ({ time, draw })), history_step_min };
  });

tool("stray_ranges", "Past ranges", "How far the market moved over past windows of the same length: percentiles (p10 to p90) of the move, and where the " +
  "latest window sits. Past ranges, not a forecast. For 'is this move unusual' across several windows at once, use stray_unusual.",
  { coin: coreCoin, window: z.union([1, 3, 7, 14, 30, 60, 90].map((n) => z.literal(n))).default(7).describe("Days: 1, 3, 7, 14, 30, 60 or 90. Default 7.") },
  "Hyperliquid daily closes", ({ coin, window }, api) => api.get(`/ranges/${coin}`, { window }));

tool("stray_depth", "Order-book depth", "US dollars resting on each side of the live Hyperliquid book within ±0.5%, ±1% and ±2% of mid. Updated every 5 seconds. " +
  "Answers 'how deep is the book'. For 'is that thin for the hour' or 'can it take $X', use stray_book_check.",
  { coin: anyCoin },
  (r) => (r.source === "live" ? "Hyperliquid live book" : "Stray's record, last minute (the live book did not answer)"),
  async ({ coin }, api) => { const b = await api.get(`/depth/${coin}`); return b.source === "live" ? b : { ...b, stale: true }; });

tool("stray_funding", "Funding", "Funding on Hyperliquid (hourly, since listing), Binance or Bybit (every 8 hours). The summary ranks the latest rate " +
  "against all history, gives the annualized rate, who pays whom, what it costs per $10,000 of position per day, the sum over the window, " +
  "and how many hours the rate has kept its sign; recent rows follow. Positive = longs pay shorts.",
  { coin: coreCoin, venue: z.enum(["hyperliquid", "binance", "bybit"]).default("hyperliquid"), hours: hours(24, 24 * 366), end: endArg },
  (r) => `${r.venue === "hyperliquid" || !r.venue ? "Hyperliquid" : r.venue[0].toUpperCase() + r.venue.slice(1)} settled funding`,
  async ({ coin, venue, hours: h, end }, api) => {
    const sp = span(h, end);
    const s = series(await api.get(`/funding/${coin}`, { venue, ...sp }), { keep: 48 });
    const per = s.interval_hours ?? 1;                       // rows are per settlement period; the summary is hourly
    const rates = s.all.map((o) => o.rate).filter(Number.isFinite);
    let same = 0;
    for (let i = rates.length - 1; i >= 0 && Math.sign(rates[i]) === Math.sign(rates[rates.length - 1]); i--) same++;
    const latest = s.summary?.latest_hourly;
    const summary = {
      ...s.summary,
      longs_pay_shorts: Number.isFinite(latest) ? latest > 0 : null,
      cost_per_10k_usd_per_day: Number.isFinite(latest) ? round(latest * 24 * 1e4, 2) : null,
      settled_sum_window: round(sum(rates), 8),
      hours_same_sign: rates.length ? same * per : null,
      ...(rates.length && same === rates.length ? { hours_same_sign_note: "Every row in the window has this sign; it may run longer. Widen hours to see." } : {}),
      ...(end ? { summary_note: "latest_* and the percentile describe the most recent settlement, not the end of this window; the rows and settled_sum_window follow the window." } : {}),
    };
    return { ...checkEmpty(s, sp), venue, window: windowOf(sp), summary };
  });

tool("stray_conditional", "When funding was like today", "Every day since 2023 is put into one of ten bands by its average hourly funding. Returns " +
  "today's band and the spread of moves over the next N days after past days in that band, beside all days. Past, not a forecast. " +
  "Shows the spread of what followed, beside all days; if the two spreads look alike, say so.",
  { coin: coreCoin, horizon: z.union([1, 3, 7, 14, 30].map((n) => z.literal(n))).default(7).describe("Days ahead: 1, 3, 7, 14 or 30. Default 7.") },
  "Hyperliquid daily funding and closes since 2023", ({ coin, horizon }, api) => api.get(`/conditional/${coin}`, { horizon }));

tool("stray_crowding", "Crowding", "Hyperliquid open interest in USD divided by USD resting within ±1% of mid: dollars of positions per dollar of book. " +
  "The latest reading's percentile ranks it against the window (default and maximum 7 days).", { coin: coreCoin, hours: hours(168, 168), end: endArg },
  "Hyperliquid open interest and live book, from Stray's record",
  async ({ coin, hours: h, end }, api) => {
    const sp = span(h, end);
    const s = checkEmpty(series(await api.get(`/crowding/${coin}`, sp), { step: 60, keep: 24 }), sp);
    return { ...s, window: windowOf(sp), norm: { what: "this window's readings", period_hours: h, samples: s.rows_total } };
  });

tool("stray_profile", "The typical day", "What is usual for each hour of the day (UTC): median depth within ±1% (both sides, USD), spread and " +
  "Hyperliquid volume per 10 minutes, over the last N days. Adds the current hour's row and the three thinnest and deepest hours. " +
  "Use it as the baseline for 'is the book thin right now' and 'when do books thin out'.",
  { coin: coreCoin, days: z.number().int().min(1).max(30).default(14).describe("Days of record to take medians over, 1 to 30. Default 14.") },
  "Stray's record, medians by UTC hour",
  async ({ coin, days }, api) => {
    const b = await api.get(`/profile/${coin}`, { days });
    const rows = (b.hours_utc ?? []).filter((r) => Number.isFinite(r.depth_1pct_usd));
    const hour = new Date().getUTCHours();
    const by = [...rows].sort((a, c) => a.depth_1pct_usd - c.depth_1pct_usd);
    const pick = (r) => ({ hour_utc: r.hour, depth_1pct_usd: r.depth_1pct_usd });
    return { ...b, current_hour_utc: hour, current_hour: rows.find((r) => r.hour === hour) ?? null,
      thinnest_hours: by.slice(0, 3).map(pick), deepest_hours: by.slice(-3).reverse().map(pick) };
  });

tool("stray_venues", "Hyperliquid vs Binance, Bybit, OKX", "The same market on four venues side by side: USD within ±0.05% to ±2% of each venue's mid, " +
  "spread, funding and open interest, and Hyperliquid's share of the four venues' depth in the tightest bands. Each venue is measured against its " +
  "own mid; null means that venue's book doesn't reach the band (Binance and Bybit often stop near ±0.1% for BTC). Funding here is the venue's " +
  "current rate: per hour on Hyperliquid, per 8 hours elsewhere; stray_funding_venues puts them on one scale.",
  { coin: coreCoin, hours: hours(1, 168), step: step(10), end: endArg }, "Hyperliquid, Binance, Bybit and OKX books, from Stray's record",
  async ({ coin, hours: h, step: s, end }, api) => {
    const sp = span(h, end);
    return { ...checkEmpty(series(await api.get(`/venues/${coin}`, { ...sp, step: s }), { keep: 6 }), sp), window: windowOf(sp) };
  });

tool("stray_flow", "Trade flow", "Hyperliquid volume by aggressor side in USD, number of buys and sells, and the largest trade; liquidations on " +
  "Binance and Bybit by side (liq_long_usd = longs closed). Hyperliquid's own liquidations are not in this data. The summary totals the window: " +
  "buy share, net USD, the largest trade and its share, and the liquidation totals.",
  { coin: coreCoin, hours: hours(6, 168), step: step(60), end: endArg },
  "Hyperliquid trades; Binance and Bybit liquidations",
  async ({ coin, hours: h, step: s, end }, api) => {
    const sp = span(h, end);
    const out = checkEmpty(series(await api.get(`/flow/${coin}`, { ...sp, step: s })), sp);
    const all = out.all ?? [];
    const buy = sum(all.map((o) => o.buy_usd)), sell = sum(all.map((o) => o.sell_usd)), big = Math.max(0, ...all.map((o) => o.max_trade_usd ?? 0));
    const summary = all.length ? {
      volume_source: "Hyperliquid", buy_usd: buy, sell_usd: sell, buy_share: round(buy / (buy + sell)), net_usd: buy - sell,
      largest_trade_usd: big, largest_trade_share_of_volume: round(big / (buy + sell), 6),
      liq_source: "Binance and Bybit", liq_long_usd_total: sum(all.map((o) => o.liq_long_usd)), liq_short_usd_total: sum(all.map((o) => o.liq_short_usd)),
    } : null;
    return { ...out, window: windowOf(sp), summary };
  });

tool("stray_positioning", "Binance positioning", "Binance's open interest, share of accounts long, top traders' long share and taker buy/sell volume, " +
  "every 5 minutes (shown hourly).", { coin: coreCoin, hours: hours(24, 24 * 31), end: endArg }, "Binance futures data",
  async ({ coin, hours: h, end }, api) => { const sp = span(h, end); return { ...checkEmpty(series(await api.get(`/positioning/${coin}`, sp), { step: 60 }), sp), window: windowOf(sp) }; });

tool("stray_whales", "Whale positioning", "Open perp positions of the top 1,500 Hyperliquid accounts by account value, totalled per coin: long, short and " +
  "net USD, accounts on each side, size-weighted leverage, and HLP's net position. Totals only; no wallets. The summary gives the long share, " +
  "net and gross USD now, and how they changed over 1 hour, 24 hours and 7 days where the window covers it (default window 7 days; rows show the newest 24).",
  { coin: coreCoin, hours: hours(168, 24 * 31), step: step(60), end: endArg }, "Hyperliquid's largest accounts, from Stray's 10-minute sweep",
  async ({ coin, hours: h, step: s, end }, api) => {
    const sp = span(h, end);
    const out = checkEmpty(series(await api.get(`/whales/${coin}`, { ...sp, step: Math.max(10, s) }), { keep: 24 }), sp);
    const all = out.all ?? [];
    const read = (o) => ({ time: iso(o.t), long_share: round(o.long_usd / (o.long_usd + o.short_usd)), net_usd: o.net_usd, gross_usd: o.long_usd + o.short_usd });
    const last = all[all.length - 1];
    const back = (hrs) => {
      const target = last.t - hrs * HOUR;
      const o = all.reduce((best, x) => (Math.abs(x.t - target) < Math.abs(best.t - target) ? x : best), all[0]);
      if (o === last || Math.abs(o.t - target) > Math.max(0.1 * hrs * HOUR, 30 * 60e3)) return null;   // the window must reach back that far
      const a = read(o), b = read(last);
      return { from: a.time, long_share_from: a.long_share, long_share_change: round(b.long_share - a.long_share), net_usd_from: a.net_usd, net_usd_change: b.net_usd - a.net_usd };
    };
    const summary = last ? { now: read(last), change: { "1h": back(1), "24h": back(24), "7d": back(168) } } : null;
    return { ...out, window: windowOf(sp), summary };
  });

tool("stray_liqmap", "Liquidation map", "Where the top Hyperliquid accounts' positions get liquidated, by distance from the mark, in USD of position value, " +
  "grouped 0-2%, 2-5%, 5-10%, 10-20% and 20-50% below and above, with the price at each edge. A sample of the largest accounts, not every position. " +
  "For these levels next to the resting book, use stray_book_check.",
  { coin: coreCoin, detail: z.boolean().default(false).describe("Also return the 0.5% bands from -50% to +50%.") },
  "Hyperliquid's largest accounts, from Stray's 10-minute sweep",
  async ({ coin, detail }, api) => {
    const { map, ...b } = await api.get(`/liqmap/${coin}`);
    const priced = (xs) => (xs ?? []).map((x) => ({ ...x, from_price: sig(b.mark * (1 + x.from_pct / 100)), to_price: sig(b.mark * (1 + x.to_pct / 100)) }));
    const out = { ...b, bands: b.bands ? { below: priced(b.bands.below), above: priced(b.bands.above) } : b.bands, sample_note: LIQ_SAMPLE };
    return detail ? { ...out, map } : out;
  });

tool("stray_implied", "Implied vs realized volatility", "Deribit's implied volatility index beside realized volatility from Hyperliquid daily closes, " +
  "the one-sigma moves each implies over 1, 7 and 30 days, and where implied ranks against every day since 2021.", { coin: z.enum(["BTC", "ETH"]) },
  "Deribit volatility index; Hyperliquid daily closes",
  async ({ coin }, api) => series(await api.get(`/implied/${coin}`), { keep: 7 }));

tool("stray_basis", "HYPE spot-perp basis", "HYPE's perp mark against HYPE/USDC spot on Hyperliquid, in basis points (positive = perp above spot), with " +
  "funding, circulating supply and spot volume.", { hours: hours(24, 24 * 31), step: step(60), end: endArg }, "Hyperliquid perp and spot, from Stray's record",
  async ({ hours: h, step: s, end }, api) => { const sp = span(h, end); return { ...checkEmpty(series(await api.get("/basis/HYPE", { ...sp, step: s })), sp), window: windowOf(sp) }; });

tool("stray_correlation", "Correlation", "Correlation of daily returns between the core markets over 30, 90 or 180 days, as a matrix in the order of coins.",
  { window: z.union([30, 90, 180].map((n) => z.literal(n))).default(30) }, "Hyperliquid daily closes", ({ window }, api) => api.get("/correlation", { window }));

tool("stray_liquidity", "Top of book", "Ten-minute medians of the top of the Hyperliquid book: spread in basis points and USD in the top 5 and top 20 levels " +
  "on each side.", { coin: coreCoin, hours: hours(24, 24 * 366), end: endArg }, "Hyperliquid book, ten-minute medians",
  async ({ coin, hours: h, end }, api) => { const sp = span(h, end); return { ...checkEmpty(series(await api.get(`/liquidity/${coin}`, sp), { step: 60 }), sp), window: windowOf(sp) }; });

tool("stray_history", "Stray's record", "Stray's own minute-by-minute record of a market: mark, oracle, hourly funding, open interest in coins, and USD " +
  "resting within ±0.05% to ±2% of mid on each side. With `end`, any past window since recording began.", { coin: anyCoin, hours: hours(24, 168), step: step(60), end: endArg },
  "Stray's minute record of Hyperliquid",
  async ({ coin, hours: h, step: s, end }, api) => { const sp = span(h, end); return { ...checkEmpty(series(await api.get(`/history/${coin}`, { ...sp, step: s })), sp), window: windowOf(sp) }; });

// ── composed tools: the comparison already made ─────────────────────────────────────────────────────────────────

const tightest = (side, usdWithin, usd) => {
  for (const b of BANDS) {
    const v = usdWithin?.[b]?.[side];
    if (Number.isFinite(v) && v >= usd) return { covered_within: b, band_usd: v, share_of_band: round(usd / v) };
  }
  return { covered_within: "beyond 2%", band_usd: usdWithin?.["2%"]?.[side] ?? null, share_of_band: null };
};
const median = (xs) => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };

tool("stray_book_check", "Book check: the exit, the size, the hour",
  "Answers 'how crowded is the exit', 'is the book thin for this hour' and 'can the book take $X' in one read. Returns the live book within " +
  "±0.5/1/2% of mid; the usual depth for this UTC hour (median over 14 days) and the ratio now/usual; with `usd`, the tightest band whose resting " +
  "orders cover that size on each side (selling meets bids, buying meets asks); dollars of open positions per dollar of book and its 7-day " +
  "percentile; and liquidation levels within 5% of the mark from the largest accounts. Resting orders can be pulled, so this is not a fill price. " +
  "Makes 4 API calls for a core market; 2 for a HIP-3 market (book and the 7-day record; crowding and liquidations are core-only).",
  { coin: anyCoin, usd: z.number().positive().max(1e10).optional().describe("A position size in US dollars to check against the book."),
    side: z.enum(["both", "sell", "buy"]).default("both").describe("Which side of the size to check: sell (into bids), buy (into asks) or both.") },
  "Hyperliquid live book; Stray's record",
  async ({ coin, usd, side }, api) => {
    const core = CORE.includes(coin);
    const [depth, profile, crowd, liq, hist] = await Promise.all([
      api.get(`/depth/${coin}`),
      core ? api.get(`/profile/${coin}`, { days: 14 }) : null,
      core ? api.get(`/crowding/${coin}`, span(168)) : null,
      core ? api.get(`/liqmap/${coin}`) : null,
      core ? null : api.get(`/history/${coin}`, { ...span(168), step: 60 }),
    ]);
    const w = depth.usd_within ?? {};
    const now1 = (w["1%"]?.bids ?? NaN) + (w["1%"]?.asks ?? NaN);
    const hour = new Date(Date.parse(depth.as_of) || Date.now()).getUTCHours();
    let usual;
    if (core) {
      const row = (profile.hours_utc ?? []).find((r) => r.hour === hour);
      usual = { hour_utc: hour, median_usd_within_1pct: row?.depth_1pct_usd ?? null, samples: row?.n ?? 0, period_days: 14, source: "Stray's record, median by UTC hour" };
    } else {
      const rows = series(hist).all.filter((o) => new Date(o.t).getUTCHours() === hour).map((o) => o.bid_1 + o.ask_1);
      usual = { hour_utc: hour, median_usd_within_1pct: median(rows), samples: rows.length, period_days: 7, source: "Stray's record, one reading per hour" };
    }
    usual.vs_norm = Number.isFinite(now1) && usual.median_usd_within_1pct ? round(now1 / usual.median_usd_within_1pct, 3) : null;
    const out = {
      coin, mid: depth.mid,
      book: { as_of: depth.as_of, source: depth.source === "live" ? "Hyperliquid live book" : "Stray's record, last minute", usd_within: w },
      usual_hour: usual,
    };
    if (usd) {
      out.size = { usd, caveat: "Resting orders at the book's as_of; they can be pulled or added to. Not a fill price." };
      if (side !== "buy") out.size.sell = { against: "bids", ...tightest("bids", w, usd) };
      if (side !== "sell") out.size.buy = { against: "asks", ...tightest("asks", w, usd) };
    }
    if (core) {
      out.positions_per_book_dollar = { value: crowd.latest?.ratio ?? null, percentile: crowd.latest?.percentile ?? null, period_days: 7, as_of: iso(crowd.latest?.t),
        source: "Hyperliquid open interest over USD within ±1%" };
      const band = (list, a, b) => (list ?? []).find((x) => {
        const lo = Math.min(Math.abs(x.from_pct), Math.abs(x.to_pct)), hi = Math.max(Math.abs(x.from_pct), Math.abs(x.to_pct));
        return lo === a && hi === b;
      })?.usd ?? null;
      const bl = liq.bands?.below, ab = liq.bands?.above;
      out.liquidations_within_5pct = {
        as_of: iso(liq.t), mark: liq.mark, sample: LIQ_SAMPLE,
        below_0_2pct_usd: band(bl, 0, 2), below_2_5pct_usd: band(bl, 2, 5), above_0_2pct_usd: band(ab, 0, 2), above_2_5pct_usd: band(ab, 2, 5),
        book_within_2pct_usd: { bids: w["2%"]?.bids ?? null, asks: w["2%"]?.asks ?? null },
        note: "Levels below the mark are longs' (forced sells into bids); above are shorts' (forced buys into asks). The book is only measured to ±2%.",
      };
    } else {
      out.omitted = "Crowding and liquidation levels are recorded for core markets only.";
    }
    return { as_of: depth.as_of, ...out };
  });

tool("stray_unusual", "Is this move unusual?",
  "Where the latest move sits among every past window of the same length, for up to three window lengths at once (default 1, 7 and 30 days): " +
  "the move, its percentile, p10 to p90, and whether it is inside the middle 80%. For BTC and ETH, adds implied against realized volatility " +
  "and implied's percentile since 2021. Makes one API call per window, plus one for BTC or ETH.",
  { coin: coreCoin, windows: z.array(z.union([1, 3, 7, 14, 30, 60, 90].map((n) => z.literal(n)))).min(1).max(3).default([1, 7, 30])
      .describe("Window lengths in days (1, 3, 7, 14, 30, 60 or 90), up to three. Default [1, 7, 30].") },
  "Hyperliquid daily closes",
  async ({ coin, windows }, api) => {
    const ws = [...new Set(windows)];
    const [ranges, implied] = await Promise.all([
      Promise.all(ws.map((window) => api.get(`/ranges/${coin}`, { window }))),
      coin === "BTC" || coin === "ETH" ? api.get(`/implied/${coin}`) : null,
    ]);
    const out = {
      coin,
      windows: ranges.map((r) => ({ window_days: r.window_days, latest_move: r.latest, latest_percentile: r.latest_percentile,
        p10: r.p10, p25: r.p25, p50: r.p50, p75: r.p75, p90: r.p90, samples: r.samples,
        inside_p10_p90: Number.isFinite(r.latest) ? r.latest >= r.p10 && r.latest <= r.p90 : null, as_of: r.as_of })),
      norm: { what: "every past window of the same length in Hyperliquid's daily closes", samples: Math.min(...ranges.map((r) => r.samples ?? 0)) },
    };
    if (implied?.summary) {
      const s = implied.summary;
      out.volatility = { implied_annual_pct: s.implied_annual_pct, implied_percentile: s.implied_percentile, implied_since: s.implied_since,
        realized_annual_pct: s.realized_annual_pct, ratio_implied_to_realized_30d: s.ratio_implied_to_realized_30d, source: "Deribit volatility index; Hyperliquid daily closes" };
    }
    return { as_of: ranges[0]?.as_of, ...out };
  });

tool("stray_oi_change", "Open interest and price changes",
  "Answers 'are positions being opened or closed into this move': the change in mark price and in open interest (in coins, so price moves " +
  "don't count as new positions) over 1 hour, 4 hours, 24 hours and 7 days, from Stray's minute record, plus the latest hourly funding. " +
  "Changes are fractions (0.012 = 1.2%). Works for core and HIP-3 markets.",
  { coin: anyCoin, end: endArg }, "Stray's minute record of Hyperliquid",
  async ({ coin, end }, api) => {
    const sp = span(168, end);
    const rows = series(await api.get(`/history/${coin}`, { ...sp, step: 60 })).all.filter((o) => Number.isFinite(o.mark) && Number.isFinite(o.oi));
    if (!rows.length) throw new Error("No record for that market in that window.");
    const last = rows[rows.length - 1];
    const back = (hrs) => {
      const target = last.t - hrs * HOUR;
      const o = rows.reduce((best, x) => (Math.abs(x.t - target) < Math.abs(best.t - target) ? x : best), rows[0]);
      if (o === last || Math.abs(o.t - target) > Math.max(0.1 * hrs * HOUR, 30 * 60e3)) return { note: "The record doesn't reach back that far in this window." };
      return { from: iso(o.t), to: iso(last.t), mark_from: o.mark, mark_to: last.mark, mark_change: round(last.mark / o.mark - 1, 5),
        oi_coins_from: sig(o.oi, 8), oi_coins_to: sig(last.oi, 8), oi_change: round(last.oi / o.oi - 1, 5) };
    };
    return { as_of: iso(last.t), coin, window: windowOf(sp), changes: { "1h": back(1), "4h": back(4), "24h": back(24), "7d": back(168) },
      funding_latest_hourly: last.funding ?? null };
  });

tool("stray_funding_venues", "Funding across venues",
  "Answers 'is the funding gap between Hyperliquid and the other venues real': each venue's current rate as an hourly equivalent and annualized " +
  "(Hyperliquid settles hourly; Binance, Bybit and OKX every 8 hours, divided by 8 here), each venue's gap to Hyperliquid, and how many hours " +
  "that gap has kept its sign in the window; plus the next funding rates Hyperliquid publishes for Binance and Bybit. Positive = longs pay shorts.",
  { coin: coreCoin, hours: hours(24, 168), end: endArg }, "Hyperliquid, Binance, Bybit and OKX funding, from Stray's record",
  async ({ coin, hours: h, end }, api) => {
    const sp = span(h, end);
    const rows = series(await api.get(`/venues/${coin}`, { ...sp, step: 60 })).all;
    if (!rows.length) throw new Error("No venue rows in that window.");
    const last = rows[rows.length - 1];
    const pred = last.predicted_funding ?? {};
    const interval = { hyperliquid: 1, binance: pred.BinPerp?.[1] ?? 8, bybit: pred.BybitPerp?.[1] ?? 8, okx: 8 };
    const hourly = (row, v) => (Number.isFinite(row?.[v]?.funding) ? row[v].funding / interval[v] : null);
    const venues = {};
    for (const v of ["hyperliquid", "binance", "bybit", "okx"]) {
      const f = hourly(last, v);
      const entry = { funding_hourly: sig(f), funding_annualized: f === null ? null : round(f * 24 * 365), settles_every_hours: interval[v] };
      if (v !== "hyperliquid") {
        const gap = (row) => { const a = hourly(row, v), b = hourly(row, "hyperliquid"); return a === null || b === null ? null : a - b; };
        const g = gap(last);
        let same = 0;
        for (let i = rows.length - 1; i >= 0; i--) { const x = gap(rows[i]); if (x === null || g === null || Math.sign(x) !== Math.sign(g)) break; same++; }
        Object.assign(entry, { gap_vs_hyperliquid_hourly: sig(g), gap_vs_hyperliquid_annualized: g === null ? null : round(g * 24 * 365),
          gap_same_sign_hours: g === null ? null : same, ...(g !== null && same === rows.length ? { gap_same_sign_note: "The whole window; widen hours to see further." } : {}) });
      }
      venues[v] = entry;
    }
    const next = Object.fromEntries(Object.entries(pred).filter(([, v]) => Array.isArray(v) && Number.isFinite(v[0]) && v[1] > 0)
      .map(([k, [rate, every]]) => [k, { rate_per_period: rate, every_hours: every, hourly: sig(rate / every) }]));
    return { as_of: iso(last.t), coin, window: windowOf(sp), venues, next_funding_published_by_hyperliquid: next };
  });

tool("stray_brief", "The market in one read",
  "The whole market's Draw and band, its change over 24 hours, all eight core markets ranked by their Draw, and for the top one to three the seven " +
  "components with their inputs. Answers 'what is stretched right now' across markets. Makes 1 API call plus one per market in `top` (default 2).",
  { top: z.number().int().min(1).max(3).default(2).describe("How many of the most tense markets to break down, 1 to 3. Default 2.") },
  "Stray's Draw, computed every 10 minutes from the record",
  async ({ top }, api) => {
    const m = await api.get("/draw", { ...span(24), step: 60 });
    const ranked = Object.entries(m.markets ?? {}).map(([coin, r]) => ({ coin, draw: r.draw, band: r.band, weight: m.weights?.[coin] ?? null }))
      .sort((a, b) => b.draw - a.draw);
    const parts = await Promise.all(ranked.slice(0, top).map((r) => api.get(`/draw/${r.coin}`, { ...span(1), step: 60 })));
    const first = m.history?.[0]?.[1], latest = m.draw;
    return {
      as_of: iso(m.t), market: { draw: m.draw, band: m.band, draw_24h_ago: first ?? null, change_24h: Number.isFinite(first) ? round(latest - first, 1) : null },
      ranked,
      breakdown: parts.map((p) => ({ coin: p.coin, draw: p.draw, band: p.band, components: p.components, inputs: p.inputs, as_of: iso(p.t) })),
      bands: m.bands, method: m.method,
    };
  });

// ── prompts: the common questions, ready to ask ─────────────────────────────────────────────────────────────────

const CLOSE = "Report what the record shows, with the time of each number and what it is compared with. Do not say what price will do. " +
  "If asked, say Stray records what markets have done.";
function prompt(name, title, description, argsSchema, text) {
  server.registerPrompt(name, { title, description, argsSchema }, (a) => ({ messages: [{ role: "user", content: { type: "text", text: `${text(a)}\n\n${CLOSE}` } }] }));
}
const coinArg = z.string().describe('A market, e.g. "BTC" or "xyz:NVDA"');

prompt("exit", "How crowded is the exit?", "The book near the price against the usual hour, positions per dollar of book, and liquidation levels nearby.",
  { coin: coinArg, usd: z.string().optional().describe("Optional position size in USD") },
  ({ coin, usd }) => `How crowded is the exit on ${coin}? Use stray_book_check${usd ? ` with usd ${usd}` : ""}: how much resting book sits near the price on each ` +
    "side against the usual depth for this hour, how many dollars of positions there are per dollar of book, and how much is set to liquidate within 5% of the mark.");
prompt("unusual", "Is this move unusual?", "The latest 1-, 7- and 30-day moves against every past window of the same length.", { coin: coinArg },
  ({ coin }) => `Is ${coin}'s recent move unusual? Use stray_unusual and say where each window's move sits among past windows of the same length.`);
prompt("pressure", "Which conditions are unusual right now?", "The measured conditions on a market that sit at unusual levels now, and how unusual each is.", { coin: coinArg },
  ({ coin }) => `Which measured conditions on ${coin} are at unusual levels right now? Use stray_draw with the coin for its seven components and inputs, ` +
    "and stray_book_check for the book, crowding and liquidation levels nearby. List each condition and how unusual it is against its own history. " +
    "Say nothing about what tends to follow.");
prompt("thin", "Is the book thin for this hour?", "The book now against the usual hour, and the hours when it is usually thinnest and deepest.", { coin: coinArg },
  ({ coin }) => `Is ${coin}'s book thin for this hour, and when is it usually thinnest? Use stray_book_check, then stray_profile for the thinnest and deepest hours.`);
prompt("venues", "Hyperliquid against the other venues", "Depth and funding on Hyperliquid, Binance, Bybit and OKX side by side.", { coin: coinArg },
  ({ coin }) => `How does ${coin} on Hyperliquid compare with Binance, Bybit and OKX right now? Use stray_venues for depth and stray_funding_venues for funding.`);
prompt("replay", "What did the book do?", "A past window from the record: the book, trade flow and top of book.",
  { coin: coinArg, from: z.string().describe("Start, ISO 8601 UTC"), to: z.string().describe("End, ISO 8601 UTC") },
  ({ coin, from, to }) => `What did ${coin}'s book do between ${from} and ${to}? Use stray_history, stray_flow and stray_liquidity with end set to ${to} ` +
    `and hours covering the window from ${from}.`);

await server.connect(new StdioServerTransport());
