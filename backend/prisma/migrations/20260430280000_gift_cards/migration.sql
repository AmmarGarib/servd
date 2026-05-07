CREATE TYPE "GiftCardStatus" AS ENUM ('active', 'redeemed_full', 'expired', 'voided');

CREATE TABLE "gift_cards" (
  "id"                TEXT             NOT NULL,
  "code"              TEXT             NOT NULL,
  "issuedAmountCents" INTEGER          NOT NULL,
  "balanceCents"      INTEGER          NOT NULL,
  "currency"          TEXT             NOT NULL DEFAULT 'PKR',
  "status"            "GiftCardStatus" NOT NULL DEFAULT 'active',
  "expiresAt"         TIMESTAMP(3),
  "buyerCustomerId"   TEXT,
  "buyerEmail"        TEXT,
  "recipientName"     TEXT,
  "recipientEmail"    TEXT,
  "message"           TEXT,
  "issuedById"        TEXT,
  "conceptId"         TEXT,
  "createdAt"         TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3)     NOT NULL,
  "voidedAt"          TIMESTAMP(3),
  "voidReason"        TEXT,
  CONSTRAINT "gift_cards_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "gift_cards_code_key"  ON "gift_cards" ("code");
CREATE INDEX "gift_cards_status_idx"       ON "gift_cards" ("status");
CREATE INDEX "gift_cards_buyerEmail_idx"   ON "gift_cards" ("buyerEmail");

CREATE TABLE "gift_card_redemptions" (
  "id"            TEXT          NOT NULL,
  "giftCardId"    TEXT          NOT NULL,
  "orderId"       TEXT,
  "amountCents"   INTEGER       NOT NULL,
  "balanceAfter"  INTEGER       NOT NULL,
  "redeemedAt"    TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "redeemedById"  TEXT,
  CONSTRAINT "gift_card_redemptions_pkey"    PRIMARY KEY ("id"),
  CONSTRAINT "gift_card_redemptions_giftFk"  FOREIGN KEY ("giftCardId") REFERENCES "gift_cards"("id") ON DELETE CASCADE
);
CREATE INDEX "gift_card_redemptions_card_redeemedAt_idx" ON "gift_card_redemptions" ("giftCardId", "redeemedAt" DESC);
