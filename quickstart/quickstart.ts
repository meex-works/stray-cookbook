// Stray API from TypeScript, no dependencies (Node 22.18+ runs .ts directly; or `npx tsx`).
//   export STRAY_API_KEY=stray_...      (from https://stray.fi/console)
//   node quickstart/quickstart.ts

const KEY = process.env.STRAY_API_KEY;
if (!KEY) throw new Error("Set STRAY_API_KEY to a key from https://stray.fi/console");

async function stray<T>(path: string, params: Record<string, string | number> = {}): Promise<T> {
  const url = new URL(`https://stray.fi/v1/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url, { headers: { Authorization: `Bearer ${KEY}` } });
  const body = await res.json();
  if (!res.ok) throw new Error(`${res.status}: ${body.error}`); // errors are JSON, written for a person
  return body as T;
}

type Draw = { draw: number; band: string; markets: Record<string, { draw: number; band: string } | null> };
type Depth = { mid: number; usd_within: Record<"0.5%" | "1%" | "2%", { bids: number; asks: number } | null> };
type Funding = { summary: { latest_hourly: number; latest_annualized: number; latest_percentile: number; samples: number } };

const usd = (n: number) => "$" + Math.round(n).toLocaleString("en-US");

const draw = await stray<Draw>("draw");
console.log(`The Draw: ${draw.draw} (${draw.band})`);

const depth = await stray<Depth>("depth/ETH");
const one = depth.usd_within["1%"];
if (one) console.log(`ETH at ${depth.mid}: ${usd(one.bids)} bids and ${usd(one.asks)} asks within 1%`);

const f = await stray<Funding>("funding/SOL", { venue: "binance" });
console.log(`SOL funding on Binance: ${(f.summary.latest_annualized * 100).toFixed(1)}% a year, ` +
  `percentile ${f.summary.latest_percentile} of ${f.summary.samples.toLocaleString("en-US")} periods`);
