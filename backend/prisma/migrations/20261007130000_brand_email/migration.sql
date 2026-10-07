-- Guest-facing email per brand (owner, 2026-10-07), alongside phone/WhatsApp.
ALTER TABLE "concepts" ADD COLUMN "email" TEXT;
UPDATE "concepts" SET "email" = 'stackd@gsfoods.pk' WHERE "slug" = 'stackd' AND "email" IS NULL;
UPDATE "concepts" SET "email" = 'simmer@gsfoods.pk' WHERE "slug" = 'simmer' AND "email" IS NULL;
UPDATE "concepts" SET "email" = 'flipd@gsfoods.pk'  WHERE "slug" = 'flipd'  AND "email" IS NULL;
