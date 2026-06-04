-- Adds two fields to Concept so the per-brand "real info" the storefront
-- needs for schema.org + footer + map links can be edited from the admin
-- dashboard rather than from a checked-in TS file.
--
--   whatsapp         — guest-facing WhatsApp number. Distinct from `phone`
--                      because the public dial number may differ from the
--                      bookings/broadcast WhatsApp Business number per the
--                      whatsapp-marketing skill.
--   addressLocality  — neighbourhood / area line (e.g. "Bukhari Commercial,
--                      DHA Phase 6"). Sits between `address` (street) and
--                      city/country in the schema.org PostalAddress shape.
--
-- Region (province) is already covered by Concept.province; country is
-- assumed Pakistan operator-wide for now.

ALTER TABLE "concepts"
  ADD COLUMN IF NOT EXISTS "whatsapp"        TEXT,
  ADD COLUMN IF NOT EXISTS "addressLocality" TEXT;
