#!/bin/sh
set -e

# ---------------------------------------------------------------------------
# Database URL resolution
# ---------------------------------------------------------------------------
# DATABASE_URL is the canonical Prisma/runtime connection string.
# Derive it from DISPATCH_DATABASE_URL when not already set.
# No destructive database operations are performed.
# ---------------------------------------------------------------------------

if [ -z "$DATABASE_URL" ]; then
    if [ -n "$DISPATCH_DATABASE_URL" ]; then
        echo "[Dispatch] DISPATCH_DATABASE_URL is set. Exporting as DATABASE_URL."
        export DATABASE_URL="$DISPATCH_DATABASE_URL"
    fi
fi

# ---------------------------------------------------------------------------
# Authentication mode warning — disabled mode is local-dev only
# ---------------------------------------------------------------------------
if [ "$DISPATCH_AUTH_MODE" = "disabled" ]; then
    echo "⚠️  [Dispatch] DISPATCH_AUTH_MODE=disabled — NO AUTHENTICATION ENFORCED. This instance must be bound to localhost only and must NOT be exposed to the internet."
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
