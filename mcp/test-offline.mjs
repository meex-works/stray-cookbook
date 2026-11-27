// Offline test: a local fake Stray API with made-up numbers in the real response shapes, so the server's maths and
// envelope are checked without a key or quota. `npm test`. (The live smoke test is `npm run test:live`.)
import http from "node:http";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const HOUR = 3600e3, NOW = Date.now(), SINCE = "2026-11-10T23:08:00Z";
const CORE = ["BTC", "ETH", "HYPE", "SOL", "XRP", "DOGE", "BNB", "SUI"];
const hourly = (from, to, stepMin = 60) => { const out = []; for (let t = Math.ceil(from / (stepMin * 60e3)) * stepMin * 60e3; t <= Math.min(to, NOW); t += stepMin * 60e3) out.push(t); return out; };
const book = { "0.5%": { bids: 1_000_000, asks: 800_000 }, "1%": { bids: 2_000_000, asks: 1_500_000 }, "2%": { bids: 3_000_000, asks: 2_500_000 } };
const PROFILE = (h) => 4_000_000 + h * 100_000;

function api(path, q) {
  const from = +q.get("from") || NOW - 24 * HOUR, to = +q.get("to") || NOW, since = Date.parse(SINCE);
  const [, ep, coin] = path.match(/^\/v1\/([a-z]+)(?:\/(.+))?$/) ?? [];
  const ts = to < since ? [] : hourly(Math.max(from, since), to, ep === "whales" ? Math.max(10, +q.get("step") || 60) : 60);
  switch (ep) {
    case "markets": return { markets: CORE, hip3: ["xyz:TEST"], recording_since: SINCE, venues: ["hyperliquid", "binance", "bybit", "okx"] };
    case "depth": return { coin, as_of: new Date(NOW).toISOString(), mid: 100, usd_within: book, source: coin === "xyz:OLD" ? "record" : "live" };
    case "profile": return { coin, days: +q.get("days"), hours_utc: Array.from({ length: 24 }, (_, h) => ({ hour: h, n: 100, depth_1pct_usd: PROFILE(h), spread_bps: 0.2, volume_usd_10m: 1e6 })) };
    case "crowding": return { coin, step_min: 10, rows: ts.map((t) => ({ t, ratio: 9 })), latest: { t: ts.at(-1), ratio: 9.5, percentile: 80 }, p10: 9, p50: 9.2, p90: 9.6 };
    case "liqmap": return { coin, t: NOW, mark: 100, accounts: 1500,
      bands: { below: [{ from_pct: -2, to_pct: 0, usd: 500_000 }, { from_pct: -5, to_pct: -2, usd: 700_000 }, { from_pct: -10, to_pct: -5, usd: 1 }],
               above: [{ from_pct: 0, to_pct: 2, usd: 300_000 }, { from_pct: 2, to_pct: 5, usd: 400_000 }, { from_pct: 5, to_pct: 10, usd: 1 }] }, map: [] };
    case "history": return { coin, step_min: 60, recording_since: SINCE,
      fields: ["t", "mark", "oracle", "funding", "oi", "bid_0.5", "ask_0.5", "bid_1", "ask_1", "bid_2", "ask_2"],
      rows: ts.map((t, i) => [t, 100 + i, 100 + i, 1e-5, 1000 + 2 * i, 1, 1, 1_000_000, 1_000_000, 1, 1]) };
    case "ranges": return { coin, as_of: new Date(NOW).toISOString(), source: "Hyperliquid daily close", window_days: +q.get("window"), samples: 700,
      latest: 0.08, latest_percentile: 93, p10: -0.06, p25: -0.03, p50: 0, p75: 0.03, p90: 0.07 };
    case "implied": return { coin, summary: { implied_annual_pct: 50, implied_percentile: 40, implied_since: "2021-04-01", realized_annual_pct: { "30d": 40 }, ratio_implied_to_realized_30d: 1.25 }, fields: ["t", "iv"], rows: [] };
    case "funding": return q.get("venue") === "binance"
      ? { coin, venue: "binance", interval_hours: 8, fields: ["t", "rate", "premium"], rows: hourly(from, to, 480).map((t) => [t, 8e-5, null]), summary: { latest_hourly: 1e-5, samples: 10 } }
      : { coin, fields: ["t", "rate", "premium"], rows: ts.map((t, i) => [t, i >= ts.length - 5 ? 1e-5 : -1e-5, 0]), summary: { latest_hourly: 1e-5, latest_percentile: 60, samples: 100 } };
    case "venues": return { coin, step_min: 60, rows: ts.map((t) => ({ t, hyperliquid: { funding: 1e-5 }, binance: { funding: 1.6e-4 }, bybit: { funding: 4e-5 }, okx: { funding: 8e-5 },
      predicted_funding: { BinPerp: [1.6e-4, 8], HlPerp: [1e-5, 1] } })) };
    case "flow": return { coin, step_min: 60, recording_since: SINCE, rows: ts.map((t) => ({ t, buy_usd: 1000, sell_usd: 3000, buys: 1, sells: 1, max_trade_usd: 400, liq_long_usd: 10, liq_short_usd: 5 })) };
    case "whales": return { coin, step_min: 60, accounts: 1500, rows: ts.map((t, i) => ({ t, long_usd: 1000 + 10 * i, short_usd: 1000, net_usd: 10 * i, n_long: 1, n_short: 1, avg_leverage: 5, mark: 100, hlp_net_usd: 0 })) };
    case "draw": return coin
      ? { coin, t: NOW, draw: 45, band: "Hand on hilt", components: { vol: 50 }, inputs: { realized_vol_7d_pct: 20 }, history: ts.map((t) => [t, 45]), history_step_min: 60 }
      : { coin: "MARKET", t: NOW, draw: 30, band: "Resting", weights: { BTC: 0.5 }, markets: Object.fromEntries(CORE.map((c, i) => [c, { draw: [40, 20, 50, 10, 5, 5, 5, 5][i], band: "x" }])),
          history: ts.map((t, i) => [t, i === 0 ? 25 : 30]), history_step_min: 60 };
    case "positioning": return { coin, venue: "binance", step_min: 5, rows: ts.map((t) => ({ t, oi: {} })) };
    case "basis": return { coin: "HYPE", step_min: 60, rows: ts.map((t) => ({ t, basis_bps: 3 })) };
    case "liquidity": return { coin, fields: ["t", "spread_bps"], rows: ts.map((t) => [t, 0.2]) };
    case "conditional": return { coin, horizon_days: +q.get("horizon"), decile: 2 };
    case "correlation": return { window_days: +q.get("window"), coins: CORE, matrix: [] };
  }
  return null;
}

let hits = 0;
const fake = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (req.headers.authorization !== "Bearer test-key") { res.writeHead(401); return res.end("{}"); }
  hits++;
  const body = api(decodeURIComponent(u.pathname), u.searchParams);
  res.writeHead(body ? 200 : 404, { "content-type": "application/json" }); res.end(JSON.stringify(body ?? { error: "not found" }));
});
await new Promise((r) => fake.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${fake.address().port}/v1`;

const client = new Client({ name: "stray-mcp-offline", version: "1" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [new URL("./index.js", import.meta.url).pathname],
  env: { ...process.env, STRAY_BASE_URL: BASE, STRAY_API_KEY: "test-key" } }));

let n = 0;
const check = async (label, fn) => { await fn(); n++; console.log(`ok   ${label}`); };
const call = async (name, args = {}) => {
  const before = hits;
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text ?? "";
  return { err: r.isError ? text : null, out: r.isError ? null : JSON.parse(text), calls: hits - before };
};

const { tools } = await client.listTools();
const NAMES = ["stray_markets", "stray_draw", "stray_ranges", "stray_depth", "stray_funding", "stray_conditional", "stray_crowding", "stray_profile",
  "stray_venues", "stray_flow", "stray_positioning", "stray_whales", "stray_liqmap", "stray_implied", "stray_basis", "stray_correlation",
  "stray_liquidity", "stray_history", "stray_book_check", "stray_unusual", "stray_oi_change", "stray_funding_venues", "stray_brief"];

await check("23 tools, all read-only", () => {
  assert.deepEqual(tools.map((t) => t.name).sort(), [...NAMES].sort());
  for (const t of tools) assert.equal(t.annotations?.readOnlyHint, true, t.name);
});

// First, before anything warms the 60 s cache: the composed tool's reported call count must equal the requests made.
await check("book_check: bands for a size, the usual hour, api_calls", async () => {
  const { out, calls, err } = await call("stray_book_check", { coin: "BTC", usd: 1_500_000 });
  assert.equal(err, null);
  assert.equal(out.api_calls, 4); assert.equal(calls, 4);
  assert.equal(out.size.sell.covered_within, "1%"); assert.equal(out.size.sell.share_of_band, 0.75);
  assert.equal(out.size.buy.covered_within, "1%"); assert.equal(out.size.buy.share_of_band, 1);
  const h = new Date(out.book.as_of).getUTCHours();
  assert.equal(out.usual_hour.hour_utc, h);
  assert.equal(out.usual_hour.vs_norm, Number((3_500_000 / PROFILE(h)).toFixed(3)));
  assert.equal(out.positions_per_book_dollar.percentile, 80);
  assert.equal(out.liquidations_within_5pct.below_0_2pct_usd, 500_000); assert.equal(out.liquidations_within_5pct.above_2_5pct_usd, 400_000);
  assert.ok(out.as_of && out.source);
});
await check("book_check: beyond 2%, one side only", async () => {
  const { out } = await call("stray_book_check", { coin: "BTC", usd: 5_000_000, side: "sell" });
  assert.equal(out.size.sell.covered_within, "beyond 2%"); assert.equal(out.size.buy, undefined);
});
await check("book_check: HIP-3 makes 2 calls and says what it left out", async () => {
  const { out, calls } = await call("stray_book_check", { coin: "xyz:TEST" });
  assert.equal(calls, 2); assert.equal(out.api_calls, 2); assert.ok(out.omitted); assert.equal(out.usual_hour.median_usd_within_1pct, 2_000_000);
});
await check("cache: a repeat profile read within 60 s costs no call", async () => {
  await call("stray_profile", { coin: "ETH" });
  const { calls, out } = await call("stray_profile", { coin: "ETH" });
  assert.equal(calls, 0); assert.equal(out.thinnest_hours[0].hour_utc, 0); assert.equal(out.deepest_hours[0].hour_utc, 23);
});
await check("every tool answers with as_of and source first", async () => {
  const args = { stray_ranges: { coin: "BTC" }, stray_depth: { coin: "BTC" }, stray_funding: { coin: "BTC" }, stray_conditional: { coin: "BTC" },
    stray_crowding: { coin: "BTC" }, stray_profile: { coin: "BTC" }, stray_venues: { coin: "BTC" }, stray_flow: { coin: "BTC" }, stray_positioning: { coin: "BTC" },
    stray_whales: { coin: "BTC" }, stray_liqmap: { coin: "BTC" }, stray_implied: { coin: "BTC" }, stray_liquidity: { coin: "BTC" }, stray_history: { coin: "BTC" },
    stray_book_check: { coin: "ETH" }, stray_unusual: { coin: "BTC" }, stray_oi_change: { coin: "BTC" }, stray_funding_venues: { coin: "BTC" } };
  for (const name of NAMES) {
    const { out, err } = await call(name, args[name] ?? {});
    assert.equal(err, null, `${name}: ${err}`);
    assert.deepEqual(Object.keys(out).slice(0, 2), ["as_of", "source"], name);
    assert.ok(out.as_of && typeof out.source === "string", name);
  }
});
await check("depth: the record fallback is flagged stale", async () => {
  const { out } = await call("stray_depth", { coin: "xyz:OLD" });
  assert.equal(out.stale, true); assert.match(out.source, /record/);
});
await check("funding: who pays, cost per $10k a day, hours on this sign", async () => {
  const { out } = await call("stray_funding", { coin: "BTC", hours: 24 });
  assert.equal(out.summary.longs_pay_shorts, true); assert.equal(out.summary.cost_per_10k_usd_per_day, 2.4); assert.equal(out.summary.hours_same_sign, 5);
  const b = (await call("stray_funding", { coin: "BTC", venue: "binance", hours: 48 })).out;
  assert.equal(b.summary.hours_same_sign % 8, 0); assert.ok(b.summary.hours_same_sign_note);
});
await check("funding_venues: 8-hour rates put on the hourly scale", async () => {
  const { out } = await call("stray_funding_venues", { coin: "BTC" });
  assert.equal(out.venues.binance.funding_hourly, 2e-5); assert.equal(out.venues.binance.gap_vs_hyperliquid_hourly, 1e-5);
  assert.equal(out.venues.bybit.gap_vs_hyperliquid_hourly, -5e-6); assert.equal(out.venues.okx.gap_vs_hyperliquid_hourly, 0);
  assert.equal(out.next_funding_published_by_hyperliquid.BinPerp.hourly, 2e-5);
});
await check("oi_change: price and open interest over 1 h to 7 d", async () => {
  const { out } = await call("stray_oi_change", { coin: "BTC" });
  const c = out.changes["1h"];
  assert.equal(c.mark_change, Number((c.mark_to / c.mark_from - 1).toFixed(5))); assert.equal(c.mark_to - c.mark_from, 1);
  assert.ok(out.changes["24h"].oi_change > 0);
});
await check("whales: long share and its change", async () => {
  const { out } = await call("stray_whales", { coin: "BTC", hours: 48 });
  assert.ok(out.summary.now.long_share > 0.5); assert.ok(out.summary.change["24h"].long_share_change > 0); assert.equal(out.summary.change["7d"], null);
  assert.ok(out.rows.length <= 24);
});
await check("flow: window totals, venues named", async () => {
  const { out } = await call("stray_flow", { coin: "BTC" });
  assert.equal(out.summary.buy_share, 0.25); assert.equal(out.summary.liq_source, "Binance and Bybit"); assert.equal(out.summary.volume_source, "Hyperliquid");
});
await check("liqmap: prices at each band edge", async () => {
  const { out } = await call("stray_liqmap", { coin: "BTC" });
  assert.equal(out.bands.below[1].from_price, 95); assert.equal(out.bands.above[0].to_price, 102); assert.ok(out.sample_note);
});
await check("unusual: windows outside the middle 80% are marked", async () => {
  const { out, calls } = await call("stray_unusual", { coin: "ETH", windows: [1, 7] });
  assert.equal(out.windows.length, 2); assert.equal(out.windows[0].inside_p10_p90, false); assert.ok(out.volatility); assert.equal(calls, 3);
});
await check("brief: ranked markets and the top breakdowns", async () => {
  const { out } = await call("stray_brief", { top: 2 });
  assert.deepEqual(out.ranked.slice(0, 2).map((r) => r.coin), ["HYPE", "BTC"]); assert.equal(out.breakdown.length, 2); assert.equal(out.market.change_24h, 5);
});
await check("end: a past window works; before the record and in the future are refused", async () => {
  const past = await call("stray_history", { coin: "BTC", hours: 6, end: new Date(NOW - 48 * HOUR).toISOString() });
  assert.equal(past.err, null); assert.ok(Date.parse(past.out.window.to) <= NOW - 48 * HOUR + 1000);
  const before = await call("stray_history", { coin: "BTC", hours: 6, end: "2026-11-01T00:00:00Z" });
  assert.match(before.err, /2026-11-10T23:08:00Z/);
  const future = await call("stray_flow", { coin: "BTC", end: new Date(NOW + 3 * HOUR).toISOString() });
  assert.match(future.err, /future/);
});
await check("bad market names never reach the URL", async () => {
  const r = await client.callTool({ name: "stray_depth", arguments: { coin: "../keys" } });
  assert.equal(r.isError, true);
});

const { prompts } = await client.listPrompts();
await check("six prompts, each closing with the no-forecast rule", async () => {
  assert.deepEqual(prompts.map((p) => p.name).sort(), ["exit", "pressure", "replay", "thin", "unusual", "venues"]);
  for (const p of prompts) {
    const args = Object.fromEntries((p.arguments ?? []).filter((a) => a.required).map((a) => [a.name, a.name === "coin" ? "BTC" : "2026-11-25T00:00:00Z"]));
    const r = await client.getPrompt({ name: p.name, arguments: args });
    assert.match(r.messages[0].content.text, /Do not say what price will do\./, p.name);
  }
});
await check("wording guard: no forecast language in descriptions or prompts", async () => {
  const texts = [...tools.map((t) => `${t.name} ${t.title} ${t.description}`)];
  for (const p of prompts) {
    const args = Object.fromEntries((p.arguments ?? []).filter((a) => a.required).map((a) => [a.name, "X"]));
    texts.push((await client.getPrompt({ name: p.name, arguments: args })).messages[0].content.text);
  }
  const allowed = /\b(not a forecast|nothing here is a forecast|not a call on what comes next|say nothing about what tends to follow|do not say what price will do)\b/gi;
  for (const t of texts) {
    const s = t.replace(allowed, "");
    assert.doesNotMatch(s, /\bforecast|\bpredict|\bwill (rise|fall|pump|dump|squeeze)|\bsqueeze|\bprice target|\bsignal\b|\brisk score/i, t.slice(0, 80));
  }
});

await client.close();
fake.close();
console.log(`\n${n} checks passed`);
