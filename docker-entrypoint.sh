#!/bin/sh
set -e

# ---------------------------------------------------------------------------
# v0.2.1 Compatibility shim — map legacy env vars to preferred names
# ---------------------------------------------------------------------------
# Legacy MISSION_CONTROL_* env vars are accepted through v0.2.1 for
# container startup compatibility. They are deprecated and will be
# removed in v0.2.2 (hard cutover).
#
# Resolution order:
#   DATABASE_URL > DISPATCH_DATABASE_URL > MISSION_CONTROL_DATABASE_URL
#   DISPATCH_AGENT_TOKEN > MISSION_CONTROL_AGENT_TOKEN
#   DISPATCH_URL > MISSION_CONTROL_URL
#
# This shim is safe to run repeatedly and never prints secret values.
# ---------------------------------------------------------------------------

if [ -n "$MISSION_CONTROL_DATABASE_URL" ] && [ -z "$DATABASE_URL" ] && [ -z "$DISPATCH_DATABASE_URL" ]; then
    echo "[Dispatch] MISSION_CONTROL_DATABASE_URL is deprecated (v0.2.1). Exporting as DATABASE_URL."
    export DATABASE_URL="$MISSION_CONTROL_DATABASE_URL"
fi

if [ -n "$MISSION_CONTROL_AGENT_TOKEN" ] && [ -z "$DISPATCH_AGENT_TOKEN" ]; then
    echo "[Dispatch] MISSION_CONTROL_AGENT_TOKEN is deprecated (v0.2.1). Exporting as DISPATCH_AGENT_TOKEN."
    export DISPATCH_AGENT_TOKEN="$MISSION_CONTROL_AGENT_TOKEN"
fi

if [ -n "$MISSION_CONTROL_URL" ] && [ -z "$DISPATCH_URL" ]; then
    echo "[Dispatch] MISSION_CONTROL_URL is deprecated (v0.2.1). Exporting as DISPATCH_URL."
    export DISPATCH_URL="$MISSION_CONTROL_URL"
fi

# Warn if both preferred and legacy are set and differ
if [ -n "$DISPATCH_DATABASE_URL" ] && [ -n "$MISSION_CONTROL_DATABASE_URL" ] && [ "$DISPATCH_DATABASE_URL" != "$MISSION_CONTROL_DATABASE_URL" ]; then
    echo "[Dispatch] Both DISPATCH_DATABASE_URL and MISSION_CONTROL_DATABASE_URL are set and differ. Using DATABASE_URL or DISPATCH_DATABASE_URL."
fi

if [ -n "$DISPATCH_AGENT_TOKEN" ] && [ -n "$MISSION_CONTROL_AGENT_TOKEN" ] && [ "$DISPATCH_AGENT_TOKEN" != "$MISSION_CONTROL_AGENT_TOKEN" ]; then
    echo "[Dispatch] Both DISPATCH_AGENT_TOKEN and MISSION_CONTROL_AGENT_TOKEN are set and differ. Using DISPATCH_AGENT_TOKEN."
fi

if [ -n "$DISPATCH_URL" ] && [ -n "$MISSION_CONTROL_URL" ] && [ "$DISPATCH_URL" != "$MISSION_CONTROL_URL" ]; then
    echo "[Dispatch] Both DISPATCH_URL and MISSION_CONTROL_URL are set and differ. Using DISPATCH_URL."
fi

# ---------------------------------------------------------------------------
# Database migrations
# ---------------------------------------------------------------------------

if [ "$SKIP_DB_MIGRATIONS" != "true" ]; then
    echo "Running database migrations..."
    ./node_modules/.bin/prisma migrate deploy
    echo "Starting Dispatch..."
fi

exec node server.js