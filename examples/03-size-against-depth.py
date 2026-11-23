"""How far from mid would an order of this size reach, on each venue?

Reads the latest cross-venue snapshot (Hyperliquid, Binance, Bybit, OKX) and finds the tightest band whose resting
USD on the side you'd take covers the order. A market buy takes asks; a sell takes bids. One call.

    python3 examples/03-size-against-depth.py BTC 5000000 buy
    python3 examples/03-size-against-depth.py HYPE 250000 sell

This is resting liquidity only: hidden orders, refills and other traders move it, so treat it as a rough guide.
"""
import sys

from stray import get, ms_ago, usd

coin = (sys.argv[1] if len(sys.argv) > 1 else "BTC").upper()
size = float(sys.argv[2]) if len(sys.argv) > 2 else 1_000_000
side = (sys.argv[3] if len(sys.argv) > 3 else "buy").lower()
take = "ask" if side == "buy" else "bid"

since, now = ms_ago(20)
snap = get(f"venues/{coin}", **{"from": since, "to": now})
latest = snap["rows"][-1]
bands = [b.rstrip("%") for b in snap["bands"]]

print(f"A {usd(size)} market {side} of {coin} against resting {take}s\n")
for venue in ("hyperliquid", "binance", "bybit", "okx"):
    book = latest.get(venue)
    if not book:
        print(f"  {venue:12} no snapshot")
        continue
    fits, deepest = None, None
    for b in bands:
        v = book.get(f"{take}_{b}")
        if v is None:
            break  # the recorded book doesn't reach this band
        deepest = (b, v)
        if v >= size:
            fits = b
            break
    if fits:
        print(f"  {venue:12} fills within ±{fits}% of mid   ({usd(book[f'{take}_{fits}'])} resting there)")
    elif deepest:
        print(f"  {venue:12} beyond ±{deepest[0]}%: only {usd(deepest[1])} resting that close")
    else:
        print(f"  {venue:12} no depth recorded")

share = snap.get("hyperliquid_share_of_depth_pct", {})
if share:
    print("\nHyperliquid's share of the four venues' depth: " + ", ".join(f"{v}% within ±{k}" for k, v in share.items()))
