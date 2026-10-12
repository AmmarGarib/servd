-- ONL-R2-01: the customer wallet is per company — one wallet per customer PER
-- COMPANY (customer_wallets, keyed (tenantId, customerId)).
--
-- Customer.walletBalance was ONE servd-wide balance. A wallet company A funded
-- (a goodwill top-up) paid an order at company B's brand, whose books then
-- debited 2050 Wallet Liability for money it never received; and the top-up
-- itself never reached A's ledger. CLAUDE.md: "gift cards, loyalty, promos …
-- stay inside the company that issued them" — the wallet now works like
-- LoyaltyAccount (migration 20261010150300).
--
-- How existing balances are assigned (no balance is created or destroyed):
--   * Every customer with a POSITIVE walletBalance gets ONE wallet, at their
--     HOME company: the company of the brand of their most recent COMPLETED
--     order; with no completed order, the oldest active company (the same
--     "primary company" lib/setup-config.ts uses).
--   * A NEGATIVE legacy walletBalance (not expected: every debit before this
--     release was a guarded `walletBalance >= amount` update) gets NO wallet —
--     a wallet starts at 0 and never goes below it (CHECK below). It is not
--     carried over as a negative row because a wallet below zero could never
--     be credited again (a CHECK, even NOT VALID, still checks every UPDATE,
--     so a refund that left it still negative would fail). The debt stays on
--     Customer.walletBalance and the migration prints a NOTICE per customer.
--     Check prod before the release:
--       SELECT id, "walletBalance" FROM customers WHERE "walletBalance" < 0;
--   * Customer.walletBalance is LEFT IN PLACE (not zeroed, not dropped) as the
--     record of what moved. Nothing reads or writes it any more.
--   * wallet_transactions get the company whose wallet they moved: an
--     order-linked row → the order's brand's company; any other row (top-ups,
--     bonuses) → the customer's home company.
--
-- The ledger is NOT touched here. Top-ups before this release never posted
-- (no Cr 2050), and wallet spends at a brand of another company debited that
-- company's 2050. The one-off reclass (Dr 6060 / Cr 2050 per company for the
-- balances moved here, plus the inter-company spends) is in the release notes.
-- Find the balances with:
--   SELECT "tenantId", SUM("balanceCents") FROM customer_wallets GROUP BY 1;
--
-- Safe to re-run: DDL is IF [NOT] EXISTS, wallets are inserted ON CONFLICT DO
-- NOTHING, and only wallet_transactions whose tenantId is still NULL are set.

CREATE TABLE IF NOT EXISTS "customer_wallets" (
    "id"           TEXT         NOT NULL,
    "tenantId"     TEXT         NOT NULL,
    "customerId"   TEXT         NOT NULL,
    "balanceCents" INTEGER      NOT NULL DEFAULT 0,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3) NOT NULL,
    CONSTRAINT "customer_wallets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "customer_wallets_tenantId_customerId_key" ON "customer_wallets"("tenantId", "customerId");
CREATE INDEX IF NOT EXISTS "customer_wallets_tenantId_idx" ON "customer_wallets"("tenantId");
CREATE INDEX IF NOT EXISTS "customer_wallets_customerId_idx" ON "customer_wallets"("customerId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customer_wallets_customerId_fkey') THEN
    ALTER TABLE "customer_wallets" ADD CONSTRAINT "customer_wallets_customerId_fkey"
      FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  -- A wallet never goes below zero (every debit is a locked, checked move in
  -- modules/wallet/service.ts; this is the backstop). Only positive legacy
  -- balances are moved in below, so the constraint is fully validated.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customer_wallets_balance_non_negative') THEN
    ALTER TABLE "customer_wallets" ADD CONSTRAINT "customer_wallets_balance_non_negative"
      CHECK ("balanceCents" >= 0);
  END IF;
END $$;

ALTER TABLE "wallet_transactions" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
CREATE INDEX IF NOT EXISTS "wallet_transactions_tenantId_customerId_idx" ON "wallet_transactions"("tenantId", "customerId");

-- Home company per customer who has a balance or any wallet history.
DROP TABLE IF EXISTS "_wallet_home";
CREATE TEMP TABLE "_wallet_home" AS
SELECT cu.id AS customer_id,
       COALESCE(
         (SELECT c."tenantId"
            FROM "orders" o JOIN "concepts" c ON c.id = o."conceptId"
           WHERE o."customerId" = cu.id AND o.status = 'completed' AND c."tenantId" IS NOT NULL
           ORDER BY COALESCE(o."completedAt", o."placedAt") DESC, o.id
           LIMIT 1),
         (SELECT t.id FROM "tenants" t
           WHERE t."deletedAt" IS NULL
           ORDER BY t."isActive" DESC, t."createdAt" ASC, t.id
           LIMIT 1)
       ) AS tenant_id
FROM "customers" cu
WHERE cu."walletBalance" <> 0
   OR EXISTS (SELECT 1 FROM "wallet_transactions" wt WHERE wt."customerId" = cu.id);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "_wallet_home" WHERE tenant_id IS NULL) THEN
    RAISE EXCEPTION 'customer_wallet_per_company: no company to assign a wallet to (no tenants?)';
  END IF;
END $$;

-- A negative legacy balance is not moved (see the header); say so loudly.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT id, "walletBalance" FROM "customers" WHERE "walletBalance" < 0 ORDER BY id LOOP
    RAISE NOTICE 'customer_wallet_per_company: customer % has a negative legacy walletBalance (% paisa) - no wallet created; it stays on customers."walletBalance"', r.id, r."walletBalance";
  END LOOP;
END $$;

INSERT INTO "customer_wallets" ("id", "tenantId", "customerId", "balanceCents", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, h.tenant_id, cu.id, cu."walletBalance", now(), now()
  FROM "customers" cu
  JOIN "_wallet_home" h ON h.customer_id = cu.id
 WHERE cu."walletBalance" > 0
ON CONFLICT ("tenantId", "customerId") DO NOTHING;

-- Order-linked history → the order's company.
UPDATE "wallet_transactions" wt
   SET "tenantId" = c."tenantId"
  FROM "orders" o
  JOIN "concepts" c ON c.id = o."conceptId"
 WHERE wt."tenantId" IS NULL
   AND wt."orderId" = o.id
   AND c."tenantId" IS NOT NULL;

-- Everything else → the customer's home company.
UPDATE "wallet_transactions" wt
   SET "tenantId" = h.tenant_id
  FROM "_wallet_home" h
 WHERE wt."tenantId" IS NULL
   AND wt."customerId" = h.customer_id;

DROP TABLE "_wallet_home";
