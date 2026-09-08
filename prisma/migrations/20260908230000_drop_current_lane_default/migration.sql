-- currentLane defaulted to a hardcoded "normal", which is not a configured lane
-- id in the default lane config and is only an alias in a renamed multi-lane
-- deployment. Ingested-but-ungroomed issues therefore landed off the configured
-- claimable lanes and a worker polling those lanes never saw them (dispatch#964).
-- Drop the default; ingest now stamps the resolved default claimable lane.
ALTER TABLE "Issue" ALTER COLUMN "currentLane" DROP DEFAULT;
