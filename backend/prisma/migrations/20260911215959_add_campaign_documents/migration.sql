-- CreateTable
CREATE TABLE "CampaignDocument" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "linkedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignDocument_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CampaignDocument_campaignId_idx" ON "CampaignDocument"("campaignId");

-- CreateIndex
CREATE INDEX "CampaignDocument_assetId_idx" ON "CampaignDocument"("assetId");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignDocument_campaignId_assetId_key" ON "CampaignDocument"("campaignId", "assetId");

-- AddForeignKey
ALTER TABLE "CampaignDocument" ADD CONSTRAINT "CampaignDocument_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignDocument" ADD CONSTRAINT "CampaignDocument_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignDocument" ADD CONSTRAINT "CampaignDocument_linkedById_fkey" FOREIGN KEY ("linkedById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
