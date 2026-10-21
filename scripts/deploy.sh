#!/usr/bin/env bash
# Deploy one or more loltools sites to Cloudflare Pages.
#   scripts/deploy.sh            # all sites
#   scripts/deploy.sh pdf qr     # some
# Needs ~/.hermes/secrets/cloudflare.env (CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID)
# or those two vars already exported. Uses a local wrangler if WRANGLER isn't set.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ] && [ -f "$HOME/.hermes/secrets/cloudflare.env" ]; then
  set -a; . "$HOME/.hermes/secrets/cloudflare.env"; set +a
fi
export CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID
WRANGLER="${WRANGLER:-npx --yes wrangler@4}"

node scripts/build.mjs "$@"

SITES=("$@")
if [ ${#SITES[@]} -eq 0 ]; then SITES=(pdf qr heic); fi
for k in "${SITES[@]}"; do
  proj=$(node -e "console.log(require('./tools.json').sites['$k'].project)")
  echo "== deploying $k -> $proj"
  $WRANGLER pages deploy "dist/$k" --project-name="$proj" --branch=main --commit-dirty=true
done
