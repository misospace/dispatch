import { defineConfig } from "prisma/config";

// NOTE: do not throw when DATABASE_URL is unset. This config is loaded by every
// Prisma CLI invocation, including `prisma generate` (run on postinstall), which
// needs only the schema — not a live datasource URL. Throwing here broke fresh
// clones: `npm install` -> postinstall -> generate -> throw. The datasource URL
// is supplied only when present (for migrate/deploy/studio); the app enforces
// DATABASE_URL at runtime via src/lib/prisma.ts.
const databaseUrl = process.env.DATABASE_URL;

export default defineConfig({
  schema: "prisma/schema.prisma",
  ...(databaseUrl ? { datasource: { url: databaseUrl } } : {}),
});
