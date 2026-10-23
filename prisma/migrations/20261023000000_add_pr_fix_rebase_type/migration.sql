-- The mechanical rebase lane (#1327) enqueues items of type REBASE. The
-- Postgres enum is the write path's contract: a value the enum lacks cannot
-- be persisted at all, so the enum here and `PrFixType` in src/types/index.ts
-- must move together.
--
-- Postgres forbids USING a newly added enum value inside the transaction that
-- added it. This migration only adds the value — no column cast, no data write
-- — so it is safe inside Prisma's migration transaction.
ALTER TYPE "PrFixType" ADD VALUE IF NOT EXISTS 'REBASE';
