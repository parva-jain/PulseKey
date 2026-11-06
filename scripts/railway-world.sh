#!/usr/bin/env bash
# Copies the World IdP client from .env to the linked Railway service, without printing the secret.
# It does not switch sign-in over: set IDENTITY=world only after the live check passes.
#   bash scripts/railway-world.sh
set -euo pipefail
cd "$(dirname "$0")/.."
get() { grep -E "^$1=" .env | head -1 | cut -d= -f2-; }
for k in WORLD_ISSUER WORLD_CLIENT_ID WORLD_CLIENT_SECRET; do
  [ -n "$(get $k)" ] || { echo "missing $k in .env"; exit 1; }
done
railway variables --skip-deploys \
  --set "WORLD_ISSUER=$(get WORLD_ISSUER)" \
  --set "WORLD_CLIENT_ID=$(get WORLD_CLIENT_ID)" \
  --set "WORLD_CLIENT_SECRET=$(get WORLD_CLIENT_SECRET)" >/dev/null
echo "World client set on Railway (values not shown). Sign-in is still the dev stand-in until IDENTITY=world."
