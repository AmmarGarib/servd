-- Per-brand master toggle for reservations. When false, the public booking
-- endpoints reject and the storefront hides the "Book a table" CTA.
-- Defaults to true so existing concepts keep their current behaviour.

ALTER TABLE "concepts"
  ADD COLUMN "reservationsEnabled" BOOLEAN NOT NULL DEFAULT true;
