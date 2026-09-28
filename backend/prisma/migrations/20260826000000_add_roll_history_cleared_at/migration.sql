-- Roll history is now loaded from the database rather than living only in the
-- browser, so "the DM cleared it" has to be recorded somewhere durable.
--
-- A watermark rather than a delete: every roll, including secret DM rolls, is
-- stored on purpose for audit (see DiceRoll.secret), and clearing the panel
-- should not destroy that record. Rolls older than this timestamp are hidden.
--
-- Additive and nullable, with no backfill: NULL means "never cleared", so every
-- existing campaign keeps its full history and no existing row is touched.
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "rollHistoryClearedAt" TIMESTAMP(3);
