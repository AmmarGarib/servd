CREATE TYPE "TaxClassification" AS ENUM ('standard', 'zero_rated', 'exempt', 'custom');

ALTER TABLE "menu_items"
  ADD COLUMN "taxClassification" "TaxClassification" NOT NULL DEFAULT 'standard',
  ADD COLUMN "overrideTaxRate"   DOUBLE PRECISION;
