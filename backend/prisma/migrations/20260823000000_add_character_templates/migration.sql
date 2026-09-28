-- Character templates: shareable starter sheets any user can publish and copy.
--
-- Purely additive. One new table that nothing previously read, and one new
-- User column defaulting to false, so no existing row changes meaning and
-- nobody gains a permission on upgrade.

-- CreateTable
CREATE TABLE "CharacterTemplate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "gameSystem" "GameSystem",
    "tokenImageUrl" TEXT,
    "data" JSONB NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CharacterTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CharacterTemplate_gameSystem_idx" ON "CharacterTemplate"("gameSystem");

-- CreateIndex
CREATE INDEX "CharacterTemplate_createdById_idx" ON "CharacterTemplate"("createdById");

-- CreateIndex
CREATE INDEX "CharacterTemplate_name_idx" ON "CharacterTemplate"("name");

-- AddForeignKey
-- SET NULL rather than CASCADE: deleting the author must not destroy a
-- template other people are still copying from.
ALTER TABLE "CharacterTemplate" ADD CONSTRAINT "CharacterTemplate_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable
-- Defaults to false so an upgrade grants nobody the permission; an admin must
-- turn it on per user, exactly as with globalAssetManager.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "templateEditor" BOOLEAN NOT NULL DEFAULT false;
