// Smoke test: starts the server the way an MCP client does, lists its tools and calls each one once.
// STRAY_API_KEY=stray_... npm run test:live   (uses about 30 calls of your quota; the composed tools make 2 to 4 each)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({ command: process.execPath, args: [new URL("./index.js", import.meta.url).pathname], env: { ...process.env } });
const client = new Client({ name: "stray-mcp-test", version: "0.1.0" });
await client.connect(transport);

const { tools } = await client.listTools();
console.log(`${tools.length} tools: ${tools.map((t) => t.name).join(", ")}`);

const calls = {
  stray_markets: {}, stray_draw: {}, stray_ranges: { coin: "HYPE" }, stray_depth: { coin: "BTC" }, stray_funding: { coin: "BTC" },
  stray_conditional: { coin: "BTC" }, stray_crowding: { coin: "ETH" }, stray_profile: { coin: "SOL" }, stray_venues: { coin: "BTC" },
  stray_flow: { coin: "HYPE" }, stray_positioning: { coin: "BTC" }, stray_whales: { coin: "BTC" }, stray_liqmap: { coin: "BTC" },
  stray_implied: { coin: "ETH" }, stray_basis: {}, stray_correlation: {}, stray_liquidity: { coin: "BTC" }, stray_history: { coin: "HYPE", hours: 6 },
  stray_book_check: { coin: "BTC", usd: 1000000 }, stray_unusual: { coin: "BTC" }, stray_oi_change: { coin: "HYPE" },
  stray_funding_venues: { coin: "BTC" }, stray_brief: {},
};
let failed = 0;
for (const t of tools) {
  const r = await client.callTool({ name: t.name, arguments: calls[t.name] ?? {} });
  const text = r.content?.[0]?.text ?? "";
  if (r.isError) failed++;
  console.log(`${r.isError ? "FAIL" : "ok  "} ${t.name.padEnd(21)} ${String(text.length).padStart(6)} chars  ${text.slice(0, 90)}`);
}
await client.close();
process.exit(failed ? 1 : 0);
