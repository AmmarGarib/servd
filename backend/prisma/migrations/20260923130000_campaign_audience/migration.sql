-- Campaigns become opt-out with an optional brand audience.
ALTER TABLE "customers" ADD COLUMN "marketingOptOutAt" TIMESTAMP(3);
ALTER TABLE "campaigns" ADD COLUMN "conceptIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
