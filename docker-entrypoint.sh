#!/bin/sh
set -e

if [ "$SKIP_DB_MIGRATIONS" != "true" ]; then
    echo "Running database migrations..."
    node node_modules/prisma/build/index.js migrate deploy
    echo "Starting Mission Control..."
fi

exec node server.js