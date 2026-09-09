-- Add the 'reversal' value the refund path has been trying to write.
--
-- orderPosting.ts creates a LoyaltyTransaction with `type: 'reversal' as never`
-- when an order is refunded. The enum never had that value, so the cast got it
-- past TypeScript and Postgres rejected it at runtime — and since the insert
-- shares a transaction with the points decrement, the whole claw-back rolled
-- back. Customers have kept every point they earned on refunded orders.
ALTER TYPE "LoyaltyTxType" ADD VALUE IF NOT EXISTS 'reversal';
