"""Watch The Draw and say when the market changes band.

The Draw scores how tense the market is against its own history, 0 (calm) to 100 (stressed), every 10 minutes.
This polls it on that schedule and prints a line when the whole market, or any core market, moves to another band.
One call every 10 minutes is about 4,300 calls a month, well inside the Builder plan.

    python3 examples/04-draw-watch.py            # runs until stopped
    python3 examples/04-draw-watch.py --once     # one reading and the components of the most tense market
"""
import sys
import time

from stray import StrayError, get

ORDER = ["Sheathed", "Resting", "Hand on hilt", "Drawing", "Drawn"]


def reading():
    d = get("draw")
    return d, {c: m["band"] for c, m in d["markets"].items() if m}


def stamp(t):
    return time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime(t / 1000))


d, bands = reading()
print(f"{stamp(d['t'])}  The Draw {d['draw']:.0f} ({d['band']})  " + "  ".join(f"{c} {m['draw']:.0f}" for c, m in d["markets"].items() if m))

if "--once" in sys.argv:
    top = max((c for c in d["markets"] if d["markets"][c]), key=lambda c: d["markets"][c]["draw"])
    one = get(f"draw/{top}")
    print(f"\nMost tense: {top} at {one['draw']:.0f} ({one['band']}). Components, 0 to 100:")
    for name, v in sorted(one["components"].items(), key=lambda kv: -(kv[1] or 0)):
        print(f"  {name:12} {v if v is not None else 'n/a':>5}")
    sys.exit()

last_market = d["band"]
while True:
    time.sleep(600)
    try:
        d, now = reading()
    except StrayError as e:
        print(f"skipped a reading: {e}")
        continue
    if d["band"] != last_market:
        way = "up" if ORDER.index(d["band"]) > ORDER.index(last_market) else "down"
        print(f"{stamp(d['t'])}  MARKET {last_market} -> {d['band']} ({way}), The Draw {d['draw']:.0f}")
        last_market = d["band"]
    for coin, band in now.items():
        if bands.get(coin) and band != bands[coin]:
            print(f"{stamp(d['t'])}  {coin} {bands[coin]} -> {band}, {d['markets'][coin]['draw']:.0f}")
    bands = now
