-- Simulate a production database that already applied the historical index
-- migration before this fix. The checksum is the original migration.sql hash.
CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
  id VARCHAR(36) PRIMARY KEY NOT NULL,
  checksum VARCHAR(64) NOT NULL,
  finished_at TIMESTAMPTZ,
  migration_name VARCHAR(255) NOT NULL,
  logs TEXT,
  rolled_back_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_steps_count INTEGER NOT NULL DEFAULT 0
);

INSERT INTO "_prisma_migrations" (
  id,
  checksum,
  finished_at,
  migration_name,
  applied_steps_count
)
VALUES (
  '84700000-0000-4000-8000-000000000001',
  '69c11252b3c85b5167d72aa778e08af99f03be877013cbc90304a703c821d227',
  now(),
  '20260104090836_add_current_lane_index',
  1
);
