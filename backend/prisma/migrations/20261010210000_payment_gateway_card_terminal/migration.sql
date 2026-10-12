-- POS connector (2026-10-10): till card payments taken on the card machine through
-- the POS connector. Its own migration: a new enum value can't be used in the
-- transaction that adds it.

-- AlterEnum
ALTER TYPE "PaymentGateway" ADD VALUE IF NOT EXISTS 'card_terminal';
