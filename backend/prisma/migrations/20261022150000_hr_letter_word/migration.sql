-- HR letters from Word files (owner, 2026-10-22). Additive only.
ALTER TABLE "hr_letter_templates" ADD COLUMN "wordFile" BYTEA;
ALTER TABLE "hr_letter_templates" ADD COLUMN "wordFileName" TEXT;
ALTER TABLE "hr_letter_templates" ADD COLUMN "custom" BOOLEAN NOT NULL DEFAULT false;
