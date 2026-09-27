CREATE TABLE "CampaignSpellDescription" (
  "id" TEXT NOT NULL,
  "campaignId" TEXT NOT NULL,
  "normalizedName" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CampaignSpellDescription_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CampaignSpellDescription_campaignId_normalizedName_key"
  ON "CampaignSpellDescription"("campaignId", "normalizedName");

ALTER TABLE "CampaignSpellDescription" ADD CONSTRAINT "CampaignSpellDescription_campaignId_fkey"
  FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
