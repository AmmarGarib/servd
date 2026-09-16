-- Self-service staff password reset.
--
-- Only a SHA-256 of the token is stored: the token itself exists solely in the
-- email/WhatsApp message, so reading this table does not hand anyone a working
-- reset link. Unique on the hash so a (vanishingly unlikely) collision is a
-- constraint error rather than two accounts sharing a link.
CREATE TABLE "staff_password_resets" (
    "id"          TEXT NOT NULL,
    "userId"      TEXT NOT NULL,
    "tokenHash"   TEXT NOT NULL,
    "expiresAt"   TIMESTAMP(3) NOT NULL,
    "consumedAt"  TIMESTAMP(3),
    "requestedIp" TEXT,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_password_resets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "staff_password_resets_tokenHash_key" ON "staff_password_resets"("tokenHash");
CREATE INDEX "staff_password_resets_userId_createdAt_idx" ON "staff_password_resets"("userId", "createdAt");
CREATE INDEX "staff_password_resets_expiresAt_idx" ON "staff_password_resets"("expiresAt");

ALTER TABLE "staff_password_resets"
  ADD CONSTRAINT "staff_password_resets_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
