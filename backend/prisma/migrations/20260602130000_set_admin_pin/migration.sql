-- One-shot bootstrap: set every admin user's PIN to the bcrypt hash of the
-- CEO-supplied value, and clear pinMustReset. This unblocks the only-active-
-- admin lockout caused by the earlier rotation migration.
--
-- Trade-off: the bcrypt hash sits in source control, so anyone with repo
-- access has a hashed value they could brute-force offline (1M keyspace,
-- ~hours on a single CPU). Acceptable as a one-time bootstrap; the admin
-- should rotate via POST /auth/staff/:id/issue-pin once signed in.

UPDATE "users"
SET
  "pin" = '$2a$10$6FaLrhR7Qq.kXCEx7SyUHebpadlp16Yw0TeJdILE6g5a4KDE1Iq4S',
  "pinMustReset" = false
WHERE "role" = 'admin' AND "deletedAt" IS NULL;
