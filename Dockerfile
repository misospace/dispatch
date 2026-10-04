FROM node:24-bookworm-slim AS base

FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

FROM base AS prod-deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Production-only dependency tree for the MCP image: the app's full production
# closure (@modelcontextprotocol/sdk, zod, next, prisma + transitive), plus tsx
# as a separate layer -- tsx is the image entrypoint but must stay a
# devDependency so the main runner image never ships it. package.json and
# package-lock.json are unchanged in git; only this layer's copy is rewritten
# (see RUN notes below, #1173).
FROM base AS mcp-deps
WORKDIR /app
COPY package.json package-lock.json* ./
# Do not COPY .npmrc into this stage: the repo .npmrc sets include=dev,
# which overrides --omit=dev and would re-admit the dev tree (#1166 proved
# the override; the CI assert would catch it, but fail at build here).
RUN npm ci --omit=dev
# Both direct npm install shapes are unusable here: installing "tsx@range"
# without --omit=dev reifies the whole tree and reinstalls every devDependency,
# and with --omit=dev npm skips an explicit package that package.json lists as
# dev-only. Recipe: rewrite THIS layer's copy of package.json (tsx ->
# dependencies, drop devDependencies; the range is still read from
# devDependencies so Renovate stays the source of truth) and let a plain
# --no-save install add only tsx + esbuild. The install pass also prunes
# stragglers this lock reifies even under --omit=dev (typescript et al.:
# dev:false in the lock via optional-peer refs);
# the "Assert MCP image ships no dev toolchain" step in .github/workflows/
# image.yaml is the guard if npm's behavior drifts.
RUN node -e 'const f="./package.json",p=require(f);const range=p.devDependencies&&p.devDependencies.tsx;if(!range)throw new Error("tsx missing from devDependencies (#1173)");p.dependencies=p.dependencies||{};p.dependencies.tsx=range;delete p.devDependencies;require("fs").writeFileSync(f,JSON.stringify(p,null,2)+"\n")' \
    && npm install --no-save --no-audit --no-fund

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
# build -- only tsx and the client code. Its node_modules comes from mcp-deps
# (npm ci --omit=dev + a tsx layer), NOT from deps: the published image must
# ship the runtime closure only, never the dev toolchain with its accepted
# dev-only advisory chain (#1173, GHSA-vfj7-8cjw-p6xm).
FROM base AS mcp
WORKDIR /app

ENV NODE_ENV=production

COPY --from=mcp-deps /app/node_modules ./node_modules
COPY tsconfig.json ./
# Ship the mcp-deps layer's rewritten manifest (devDependencies removed) rather
# than the repo one: trivy-style manifest scanners must not see dev deps that
# are not in this image. tsx does not read package.json at runtime.
COPY --from=mcp-deps /app/package.json ./package.json
# Only the server's import closure -- copying all of src/lib would put 111
# unrelated files, tests included, into a published image.
COPY src/mcp/server.ts ./src/mcp/
COPY src/lib/mc-client.ts src/lib/dispatch-env.ts src/lib/lane-config.ts ./src/lib/

RUN addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 --ingroup nodejs mcp

USER mcp

ENTRYPOINT ["./node_modules/.bin/tsx", "src/mcp/server.ts"]
