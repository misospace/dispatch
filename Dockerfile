FROM node:24-bookworm-slim AS base

FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

FROM base AS prod-deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

FROM base AS builder
WORKDIR /app
ARG DATABASE_URL=postgresql://localhost:5432/dispatch
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN npx prisma generate
# DATABASE_URL is needed at build time for Next.js static generation (npm run build).
# The runner stage does NOT inherit this ENV; production code requires DATABASE_URL
# at runtime via the check in src/lib/prisma.ts.
# Inherit from the ARG above so --build-arg DATABASE_URL=... actually flows
# through to prisma generate and next build. A hardcoded placeholder here would
# silently override the build arg and could change Prisma client generation
# (e.g., connector/extension-aware query generation) in unexpected ways.
ENV DATABASE_URL=${DATABASE_URL}
RUN npm run build

FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production

RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 --ingroup nodejs nextjs

COPY --from=prod-deps --chown=nextjs:nodejs /app/node_modules ./node_modules

COPY --from=builder /app/docker-entrypoint.sh /docker-entrypoint.sh
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
# output: "standalone" does not bundle public/, so copy it explicitly —
# otherwise the logo and favicons under /images/* 404 in production.
COPY --from=builder /app/public ./public
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts

RUN mkdir -p /app/.next/cache && chown -R nextjs:nodejs /app/.next/cache

RUN chmod +x /docker-entrypoint.sh

USER nextjs

EXPOSE 3000

ENV PORT=3000

# Next standalone binds to $HOSTNAME. Kubernetes sets HOSTNAME to the pod name,
# which resolves to the pod IP — the server then skips loopback and the in-app
# scheduler's POSTs to 127.0.0.1 get ECONNREFUSED. Bind all interfaces.
ENV HOSTNAME=0.0.0.0

ENTRYPOINT ["/docker-entrypoint.sh"]

# MCP server image (stdio transport) for the in-cluster toolhive gateway. It
# talks to the dispatch API over HTTP, so it needs neither prisma nor the Next
# build -- only tsx and the client code.
FROM base AS mcp
WORKDIR /app

ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src/lib ./src/lib
COPY src/mcp ./src/mcp

RUN addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 --ingroup nodejs mcp

USER mcp

ENTRYPOINT ["./node_modules/.bin/tsx", "src/mcp/server.ts"]
