-- Bootstrap fix for the previous user_pin_must_reset migration.
--
-- The previous migration flagged EVERY PIN-bearing User for forced rotation,
-- including the admin (CEO). That created a chicken-and-egg lockout: the
-- admin is the one who issues new PINs to everyone else, but they couldn't
-- sign in to do it. /auth/pin handler now also exempts admin from the
-- pinMustReset gate, but legacy rows still carry the flag — clear it here
-- so admins can sign in cleanly.
--
-- Non-admin staff stay flagged and must have their PINs reissued by the
-- admin via POST /auth/staff/:id/issue-pin before they can sign in.

UPDATE "users"
SET "pinMustReset" = false
WHERE "role" = 'admin';
