#!/usr/bin/env bash
# Sends the production configuration to the linked Railway service. Run it yourself after `railway link`:
#   bash scripts/railway-env.sh https://<your-service>.up.railway.app
# Secrets are read from .env (or generated) and passed straight to the Railway CLI; nothing is printed.
# The server needs only three secrets: the study account key (claims), the 0G key, and a fresh pool key.
# The buyer agent's key stays on your laptop.
set -euo pipefail
cd "$(dirname "$0")/.."
BASE="${1:?usage: bash scripts/railway-env.sh https://<public-url>}"
get() { grep -E "^$1=" .env | head -1 | cut -d= -f2-; }

for k in STUDY_ACCOUNT_ID STUDY_PRIVATE_KEY ZG_SK BUYER_ACCOUNT_ID HCS_TOPIC_ID; do
  [ -n "$(get $k)" ] || { echo "missing $k in .env"; exit 1; }
done

# A new key just for production: the production pool starts empty, and the local key never leaves this machine.
POOL_KEK_PROD="$(openssl rand -base64 32)"

railway variables --skip-deploys \
  --set "API_BASE=$BASE" \
  --set "PGLITE_DIR=/data/pool" \
  --set "IDENTITY=dev" \
  --set "SEALED=0g" \
  --set "PER_PERSON_MICRO=1000" \
  --set "MIN_CLAIM_MICRO=100" \
  --set "SEED_PEOPLE=200" \
  --set "STUDY_ACCOUNT_ID=$(get STUDY_ACCOUNT_ID)" \
  --set "BUYER_ACCOUNT_ID=$(get BUYER_ACCOUNT_ID)" \
  --set "HCS_TOPIC_ID=$(get HCS_TOPIC_ID)" \
  --set "STUDY_PRIVATE_KEY=$(get STUDY_PRIVATE_KEY)" \
  --set "ZG_SK=$(get ZG_SK)" \
  --set "POOL_KEK=$POOL_KEK_PROD" >/dev/null

echo "variables set (values not shown). Deploy with: railway up"
