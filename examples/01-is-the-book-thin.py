"""Is the book thin right now?

Compares USD resting within 1% of mid now with the median for this hour of the day over the last week, and shows
how crowded the market is (open interest per dollar of book) against the same week. Three calls per market.

    python3 examples/01-is-the-book-thin.py            # BTC, ETH, HYPE
    python3 examples/01-is-the-book-thin.py SOL DOGE
"""
import sys
import time

from stray import get, usd

coins = [c.upper() for c in sys.argv[1:]] or ["BTC", "ETH", "HYPE"]
hour = time.gmtime().tm_hour

print(f"Depth within 1% of mid, now vs the median at {hour:02d}:00 UTC over the last 7 days\n")
print(f"{'':6}{'now':>10}{'typical':>10}{'vs typical':>12}{'crowding pct':>14}")
for coin in coins:
    now = get(f"depth/{coin}")["usd_within"]["1%"]
    typical = next(h for h in get(f"profile/{coin}", days=7)["hours_utc"] if h["hour"] == hour)["depth_1pct_usd"]
    crowd = get(f"crowding/{coin}")["latest"]
    total = now["bids"] + now["asks"] if now else None
    change = f"{total / typical - 1:+.0%}" if total and typical else "n/a"
    print(f"{coin:6}{usd(total):>10}{usd(typical):>10}{change:>12}{crowd['percentile']:>14}")

print("\nCrowding percentile: where open interest per dollar of book sits in the last 7 days (100 = most crowded).")
print("A high percentile means more dollars of open positions per dollar resting near the price than usual this week.")
