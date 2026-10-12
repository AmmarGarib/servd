-- ONL-04: loyalty accounts are per company — one per customer PER COMPANY.
--
-- One shared account per customer let points earned at one company (GS Foods)
-- be spent at another (Karachi Grill Co), whose books then carried a negative
-- 2060 Loyalty Liability for points it never issued, while the issuing
-- company kept a liability for points already spent. CLAUDE.md: "gift cards,
-- loyalty, promos … stay inside the company that issued them".
--
-- After this migration loyalty_accounts is keyed (tenantId, customerId).
--
-- How existing rows are assigned (data only moves between a customer's own
-- accounts; no balance is created or destroyed, and no row is deleted):
--
--   1. Each transaction linked to an order belongs to the company of that
--      order's brand. Per account and company: net points (sum of deltas) and
--      net earned points (earns less claw-backs).
--   2. The account's HOME company is where it earned the most points. If it
--      earned nowhere through an order (ambiguous: only birthday / referral /
--      reservation bonuses, or redemptions only), the home is the company of
--      the customer's FIRST order; with no order at all, the oldest active
--      company (the same "primary company" lib/setup-config.ts uses).
--   3. The existing row becomes the home company's account.
--   4. For every OTHER company the account has order-linked activity in, a new
--      account is created holding that company's net points (never below 0,
--      and never more than the balance not yet allocated), its net earned
--      points as lifetimePoints, the stamp counts of that company's brands, and
--      tier 'bronze' (the tier ladder is per company; it is re-evaluated on the
--      customer's next completed order there). That company's order-linked
--      transactions move to the new account.
--   5. The home account keeps the rest: old balance minus what moved, old
--      lifetime minus what moved, the remaining stamps, and its tier.
--      Unattributed points (transactions with no order) stay at home.
--
-- Points SPENT at a company that did not issue them (a negative net at that
-- company — the ONL-04 case) are absorbed by the home company's balance, so
-- the customer's total is unchanged. That company's redemptions (and any
-- positive reversal giving them back) STAY on the home account, tagged
-- "[cross-company redemption …]" in their description: if such an order is
-- cancelled or refunded later, the restore (orderPosting.ts postOrderRefund)
-- puts the points back on the account of the company that ISSUED them, and
-- the ledger reversal unwinds the 'loyalty.redeem' entry in the spending
-- company's books, where it was booked (loyaltyPosting.ts, LEDGER-R9). Only
-- that company's earns and claw-backs move to its new account, and its new
-- balance is what it earned net of claw-backs.
-- The ledger is NOT touched here: the spending company's 2060 still shows the
-- debit its 'loyalty.redeem' entry booked, and the issuing company's 2060 the
-- accrual. Find them with:
--   SELECT * FROM loyalty_transactions WHERE description LIKE '%[cross-company redemption%'
-- The one-off inter-company reclass is described in the release notes.
--
-- Safe to re-run: DDL is IF [NOT] EXISTS and only rows whose tenantId is
-- still NULL are assigned.

ALTER TABLE "loyalty_accounts" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
-- A customer can now hold one account per company.
DROP INDEX IF EXISTS "loyalty_accounts_customerId_key";

DROP TABLE IF EXISTS "_loyalty_share";
CREATE TEMP TABLE "_loyalty_share" AS
SELECT lt."loyaltyAccountId" AS account_id,
       c."tenantId"          AS tenant_id,
       SUM(lt."pointsDelta")::INT AS net_points,
       SUM(CASE
             WHEN lt."type" = 'earn' THEN lt."pointsDelta"
             WHEN lt."type" = 'reversal' AND lt."pointsDelta" < 0 THEN lt."pointsDelta"
             ELSE 0
           END)::INT AS earned,
       -- What the company's own rows net to WITHOUT its redemptions (and the
       -- positive reversals that give redemptions back): its balance when its
       -- redemptions stay with the issuing (home) company.
       SUM(CASE
             WHEN lt."type" = 'redeem' THEN 0
             WHEN lt."type" = 'reversal' AND lt."pointsDelta" > 0 THEN 0
             ELSE lt."pointsDelta"
           END)::INT AS net_without_redeems
FROM "loyalty_transactions" lt
JOIN "orders"   o ON o.id = lt."orderId"
JOIN "concepts" c ON c.id = o."conceptId"
WHERE c."tenantId" IS NOT NULL
GROUP BY lt."loyaltyAccountId", c."tenantId";

DO $$
DECLARE
  a              RECORD;
  s              RECORD;
  home           TEXT;
  remaining      INT;
  alloc          INT;
  new_id         TEXT;
  moved_balance  INT;
  moved_lifetime INT;
  split_tenants  TEXT[];
  stamps         JSONB;
  overspent      BOOLEAN;
BEGIN
  FOR a IN
    SELECT id, "customerId", "pointsBalance", "lifetimePoints", "stampCounts"
    FROM "loyalty_accounts"
    WHERE "tenantId" IS NULL
  LOOP
    -- 2. Home company.
    home := NULL;
    SELECT sh.tenant_id INTO home
      FROM "_loyalty_share" sh
      WHERE sh.account_id = a.id AND sh.earned > 0
      ORDER BY sh.earned DESC, sh.tenant_id
      LIMIT 1;
    IF home IS NULL THEN
      SELECT c."tenantId" INTO home
        FROM "orders" o JOIN "concepts" c ON c.id = o."conceptId"
        WHERE o."customerId" = a."customerId" AND c."tenantId" IS NOT NULL
        ORDER BY o."placedAt" ASC, o.id
        LIMIT 1;
    END IF;
    IF home IS NULL THEN
      SELECT sh.tenant_id INTO home
        FROM "_loyalty_share" sh
        WHERE sh.account_id = a.id
        ORDER BY sh.tenant_id
        LIMIT 1;
    END IF;
    IF home IS NULL THEN
      SELECT t.id INTO home
        FROM "tenants" t
        WHERE t."deletedAt" IS NULL
        ORDER BY t."isActive" DESC, t."createdAt" ASC
        LIMIT 1;
    END IF;
    IF home IS NULL THEN
      RAISE EXCEPTION 'loyalty_per_company: no company to assign loyalty account % to', a.id;
    END IF;

    stamps := CASE WHEN jsonb_typeof(a."stampCounts") = 'object' THEN a."stampCounts" ELSE '{}'::jsonb END;

    -- 4. One account per other company with order-linked activity.
    remaining      := GREATEST(a."pointsBalance", 0);
    moved_balance  := 0;
    moved_lifetime := 0;
    split_tenants  := ARRAY[]::TEXT[];
    FOR s IN
      SELECT * FROM "_loyalty_share" sh
      WHERE sh.account_id = a.id AND sh.tenant_id <> home
      ORDER BY sh.tenant_id
    LOOP
      -- Spent more here than this company issued: the redemptions were the
      -- home company's points (see the header) and stay on its account.
      overspent := s.net_points < 0;
      alloc     := LEAST(GREATEST(CASE WHEN overspent THEN s.net_without_redeems ELSE s.net_points END, 0), remaining);
      remaining := remaining - alloc;
      new_id    := gen_random_uuid()::text;

      INSERT INTO "loyalty_accounts"
        ("id", "tenantId", "customerId", "pointsBalance", "lifetimePoints", "tier", "stampCounts", "createdAt", "updatedAt")
      VALUES (
        new_id, s.tenant_id, a."customerId", alloc, GREATEST(s.earned, 0), 'bronze',
        COALESCE((
          SELECT jsonb_object_agg(e.key, e.value)
          FROM jsonb_each(stamps) e
          WHERE EXISTS (SELECT 1 FROM "concepts" c WHERE c.slug = e.key AND c."tenantId" = s.tenant_id)
        ), '{}'::jsonb),
        now(), now()
      );

      UPDATE "loyalty_transactions" lt
         SET "loyaltyAccountId" = new_id
        FROM "orders" o
        JOIN "concepts" c ON c.id = o."conceptId"
       WHERE lt."loyaltyAccountId" = a.id
         AND lt."orderId" = o.id
         AND c."tenantId" = s.tenant_id
         AND NOT (overspent AND (lt."type" = 'redeem' OR (lt."type" = 'reversal' AND lt."pointsDelta" > 0)));

      IF overspent THEN
        UPDATE "loyalty_transactions" lt
           SET "description" = COALESCE(lt."description", '') || ' [cross-company redemption kept on the issuing account — migration 20261010150300]'
          FROM "orders" o
          JOIN "concepts" c ON c.id = o."conceptId"
         WHERE lt."loyaltyAccountId" = a.id
           AND lt."orderId" = o.id
           AND c."tenantId" = s.tenant_id
           AND (lt."type" = 'redeem' OR (lt."type" = 'reversal' AND lt."pointsDelta" > 0))
           AND COALESCE(lt."description", '') NOT LIKE '%[cross-company redemption%';
      END IF;

      moved_balance  := moved_balance + alloc;
      moved_lifetime := moved_lifetime + GREATEST(s.earned, 0);
      split_tenants  := split_tenants || s.tenant_id;
    END LOOP;

    -- 3 + 5. The existing row is the home company's account.
    UPDATE "loyalty_accounts"
       SET "tenantId"       = home,
           "pointsBalance"  = a."pointsBalance" - moved_balance,
           "lifetimePoints" = GREATEST(a."lifetimePoints" - moved_lifetime, 0),
           "stampCounts"    = COALESCE((
             SELECT jsonb_object_agg(e.key, e.value)
             FROM jsonb_each(stamps) e
             WHERE NOT EXISTS (
               SELECT 1 FROM "concepts" c
               WHERE c.slug = e.key AND c."tenantId" = ANY(split_tenants)
             )
           ), '{}'::jsonb),
           "updatedAt"      = now()
     WHERE id = a.id;
  END LOOP;
END $$;

DROP TABLE "_loyalty_share";

ALTER TABLE "loyalty_accounts" ALTER COLUMN "tenantId" SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "loyalty_accounts_tenantId_customerId_key" ON "loyalty_accounts"("tenantId", "customerId");
CREATE INDEX IF NOT EXISTS "loyalty_accounts_customerId_idx" ON "loyalty_accounts"("customerId");
