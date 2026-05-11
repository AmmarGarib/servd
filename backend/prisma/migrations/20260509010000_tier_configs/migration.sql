-- Loyalty tier perks. One row per tier; operator-tunable. Defaults inserted
-- below give the engine real perks immediately without operator setup.

CREATE TABLE "tier_configs" (
  "id"                       TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "tier"                     TEXT NOT NULL UNIQUE,
  "alwaysFreeDelivery"       BOOLEAN NOT NULL DEFAULT false,
  "freeDeliveryAboveCents"   INTEGER,
  "birthdayDiscountPct"      INTEGER,
  "priorityReservationDays"  INTEGER,
  "waitlistPriority"         BOOLEAN NOT NULL DEFAULT false,
  "monthlyCompCents"         INTEGER,
  "earlyMenuAccess"          BOOLEAN NOT NULL DEFAULT false,
  "freeBirthdayItem"         BOOLEAN NOT NULL DEFAULT false,
  "description"              TEXT,
  "createdAt"                TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"                TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO "tier_configs" (id, tier, "alwaysFreeDelivery", "freeDeliveryAboveCents", "birthdayDiscountPct", "priorityReservationDays", "waitlistPriority", "monthlyCompCents", "earlyMenuAccess", "freeBirthdayItem", description) VALUES
  (gen_random_uuid()::text, 'bronze', false, NULL,  NULL, NULL,  false, NULL, false, false, 'Default tier — earn points, redeem at checkout. No extras.'),
  (gen_random_uuid()::text, 'silver', false, 50000, 50,   3,     false, NULL, false, false, 'Free delivery on orders over PKR 500, birthday 50% off, book 3 days ahead beyond standard.'),
  (gen_random_uuid()::text, 'gold',   true,  NULL,  100,  7,     true,  50000, true, true, 'Free delivery always, birthday free meal, book 7 days ahead, waitlist priority, PKR 500/mo comp credit, early access to new menu items.')
ON CONFLICT (tier) DO NOTHING;
