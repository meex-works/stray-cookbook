"""Stray API from Python, standard library only.

    export STRAY_API_KEY=stray_...      (from https://stray.fi/console)
    python3 quickstart/quickstart.py
"""
import json
import os
import urllib.error
import urllib.parse
import urllib.request

KEY = os.environ.get("STRAY_API_KEY") or exit("Set STRAY_API_KEY to a key from https://stray.fi/console")


def stray(path, **params):
    url = "https://stray.fi/v1/" + path + ("?" + urllib.parse.urlencode(params) if params else "")
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {KEY}", "User-Agent": "stray-quickstart"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        raise SystemExit(f"{e.code}: {json.load(e).get('error')}")  # errors are JSON, written for a person


draw = stray("draw")
print(f"The Draw: {draw['draw']} ({draw['band']})")
for coin, m in draw["markets"].items():
    print(f"  {coin:<5} {m['draw']:>5}  {m['band']}")

depth = stray("depth/BTC")["usd_within"]["1%"]
print(f"BTC within 1% of mid: ${depth['bids']:,.0f} bids, ${depth['asks']:,.0f} asks")

r = stray("ranges/HYPE", window=7)
print(f"HYPE over 7 days: {r['latest']:+.1%}, percentile {r['latest_percentile']} of {r['samples']} past weeks "
      f"(p10 {r['p10']:+.1%}, p90 {r['p90']:+.1%})")
