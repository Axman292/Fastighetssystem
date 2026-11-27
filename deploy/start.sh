#!/usr/bin/env bash
# Startar testmiljön i en enda tjänst (används av render.yaml):
# databasen migreras, inloggning och demodata läggs upp om de saknas,
# sedan startas API:et internt på 127.0.0.1:4000 och webben på $PORT.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${DATABASE_URL:?DATABASE_URL saknas}"
: "${SEED_ADMIN_PASSWORD:?SEED_ADMIN_PASSWORD saknas}"
export API_PORT="${API_PORT:-4000}"
export API_URL="http://127.0.0.1:${API_PORT}"
# Gratisnivån har 512 MB minne som delas av API och webb.
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=192}"

node apps/api/dist/scripts/migrate.js
node apps/api/dist/scripts/seed.js
if [ "${DEMO_DATA:-false}" = "true" ]; then
  # Demodata är bara en hjälp: misslyckas den ska tjänsten ändå starta.
  node apps/api/dist/scripts/seed-demo.js || echo "Demodata kunde inte läggas upp, tjänsten startar ändå."
fi

node apps/api/dist/main.js &
api_pid=$!
(cd apps/web && exec node node_modules/next/dist/bin/next start -p "${PORT:-3000}") &
web_pid=$!

# Om någon av processerna stannar avslutas tjänsten, så att Render startar om den.
trap 'kill $api_pid $web_pid 2>/dev/null || true' TERM INT
wait -n $api_pid $web_pid
kill $api_pid $web_pid 2>/dev/null || true
exit 1
