#!/bin/sh
# Stray API from the shell. Needs curl and jq.
#   export STRAY_API_KEY=stray_...      (from https://stray.fi/console)
#   sh quickstart/curl.sh
set -eu
: "${STRAY_API_KEY:?Set STRAY_API_KEY to a key from https://stray.fi/console}"
stray() { curl -fsS "https://stray.fi/v1/$1" -H "Authorization: Bearer $STRAY_API_KEY"; }

echo "The Draw, whole market (0 calm, 100 stressed):"
stray draw | jq -r '"  \(.draw) \(.band)"'

echo "BTC book within 1% of mid:"
stray depth/BTC | jq -r '.usd_within["1%"] | "  bids $\(.bids)  asks $\(.asks)"'

echo "HYPE funding, latest hour against all history:"
stray funding/HYPE | jq -r '.summary | "  \(.latest_annualized * 100 | floor)% a year, percentile \(.latest_percentile)"'

echo "Your quota:"
curl -fsS -o /dev/null -D - "https://stray.fi/v1/markets" -H "Authorization: Bearer $STRAY_API_KEY" \
  | grep -i '^x-quota-remaining' | sed 's/^/  /'
