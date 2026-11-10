-- AlterTable
ALTER TABLE "refresh_tokens" ADD COLUMN "family_id" UUID NOT NULL DEFAULT gen_random_uuid();

-- CreateIndex
CREATE INDEX "refresh_tokens_family_id_idx" ON "refresh_tokens"("family_id");
