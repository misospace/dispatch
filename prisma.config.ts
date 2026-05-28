import { defineConfig } from "prisma/config";

const databaseUrl = process.env.DATABASE_URL;

if (process.env.NODE_ENV === "production" && !databaseUrl) {
  throw new Error(
    "DATABASE_URL is not set. Please set the DATABASE_URL environment variable before starting the application.",
  );
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url: databaseUrl ?? "postgresql://localhost:5432/dispatch",
  },
});
