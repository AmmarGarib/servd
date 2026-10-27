-- Owner, 2026-10-27: "u can turn loyalty on. but ordering needs to be off on all brands for now."
-- Loyalty ON (lib/loyaltyPause.ts; absent = paused). Customer ordering OFF (lib/onlineOrdering.ts; absent = off) —
-- written explicitly so the state is visible; the CEO switches either one later on its page (audited).
INSERT INTO "settings" ("key", "value", "updatedAt")
VALUES ('loyalty.paused', '{"paused":false,"reason":"Owner, 2026-10-27: turn loyalty on"}', now())
ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value", "updatedAt" = now();

INSERT INTO "settings" ("key", "value", "updatedAt")
VALUES ('ordering.online', '{"on":false,"reason":"Owner, 2026-10-27: ordering off on all brands for now"}', now())
ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value", "updatedAt" = now();
