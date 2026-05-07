-- Add FK constraint from campaign_sends.customerId → customers.id
-- The customerId column already exists; this migration wires the relation

ALTER TABLE "campaign_sends"
  ADD CONSTRAINT "campaign_sends_customerId_fkey"
  FOREIGN KEY ("customerId") REFERENCES "customers"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
