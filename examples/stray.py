"""A tiny Stray API client, standard library only. The examples in this folder import it.

    export STRAY_API_KEY=stray_...      (from https://stray.fi/console)
"""
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = os.environ.get("STRAY_BASE_URL", "https://stray.fi/v1")
CORE = ["BTC", "ETH", "HYPE", "SOL", "XRP", "DOGE", "BNB", "SUI"]


class StrayError(Exception):
    pass


def get(path, **params):
    """GET /v1/<path>. Retries once on 429 (waiting Retry-After) and on 502."""
    key = os.environ.get("STRAY_API_KEY")
    if not key:
        raise StrayError("Set STRAY_API_KEY to a key from https://stray.fi/console")
    url = f"{BASE}/{path}" + ("?" + urllib.parse.urlencode(params) if params else "")
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {key}", "User-Agent": "stray-cookbook"})
    for attempt in (1, 2):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            try:
                body = json.loads(e.read() or b"{}")
            except ValueError:                      # an HTML error page from a proxy or the edge
                body = {}
            if attempt == 1 and e.code in (429, 502, 503, 504):
                time.sleep(min(30, int(e.headers.get("Retry-After") or 2)))
                continue
            raise StrayError(f"{e.code}: {body.get('error', e.reason)}") from None
        except (urllib.error.URLError, TimeoutError, ValueError) as e:   # network drop, timeout, a body that isn't JSON
            if attempt == 1:
                time.sleep(2)
                continue
            raise StrayError(f"Couldn't reach the Stray API: {e}") from None


def rows(body):
    """{fields, rows: [[...]]} -> list of dicts. Rows that are already dicts pass through."""
    f = body.get("fields")
    return [dict(zip(f, r)) for r in body["rows"]] if f else body["rows"]


def ms_ago(minutes):
    """(from, to) in Unix milliseconds for the last `minutes`."""
    now = int(time.time() * 1000)
    return now - minutes * 60_000, now


def usd(n):
    if n is None:
        return "n/a"
    for unit, size in (("B", 1e9), ("M", 1e6), ("k", 1e3)):
        if abs(n) >= size:
            return f"${n / size:,.1f}{unit}"
    return f"${n:,.0f}"
