ALTER TABLE "Campaign"
ADD COLUMN "combatState" JSONB;

ALTER TABLE "Map"
ADD COLUMN "difficultTerrain" JSONB NOT NULL DEFAULT '[]'::jsonb;
