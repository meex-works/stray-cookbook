"""Where does funding sit, and what followed days like this one?

Ranks the latest funding against every hour since listing on Hyperliquid, Binance and Bybit, then puts today in its
funding decile and shows the spread of moves over the next 1, 7 and 30 days after past days in that decile, beside
all days. Past, not a forecast. Six calls.

    python3 examples/02-funding-regime.py HYPE
"""
import sys

from stray import get

coin = (sys.argv[1] if len(sys.argv) > 1 else "BTC").upper()

print(f"{coin} funding, latest against all history (hourly equivalent)\n")
for venue in ("hyperliquid", "binance", "bybit"):
    s = get(f"funding/{coin}", venue=venue)["summary"]
    print(f"  {venue:12} {s['latest_annualized']:+8.1%} a year   percentile {s['latest_percentile']:>3}   since {s['since'][:10]}")

print(f"\nAfter past days with funding like today's on Hyperliquid:\n")
print(f"  {'next':>8}  {'decile':>6}  {'p10':>7} {'p50':>7} {'p90':>7}   {'all days p10/p50/p90':>24}")
for horizon in (1, 7, 30):
    c = get(f"conditional/{coin}", horizon=horizon)
    w, a = c["when_funding_was_like_this"], c["all_days"]
    print(f"  {horizon:>4} day{'s' if horizon > 1 else ' '}  {c['decile']:>6}  {w['p10']:+7.1%} {w['p50']:+7.1%} {w['p90']:+7.1%}"
          f"   {a['p10']:+7.1%} {a['p50']:+7.1%} {a['p90']:+7.1%}   ({w['samples']} days)")

print("\nDecile 1 = the lowest-funding tenth of days, 10 = the highest. Past moves, not a forecast.")
