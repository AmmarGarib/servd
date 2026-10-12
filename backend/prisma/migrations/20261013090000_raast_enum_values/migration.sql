-- Raast QR (2026-10-12, owner decision): Raast is its own tender (instant bank
-- transfer to the company's receiving account, digital tax rate) and replaces
-- Keenu QR at the till. keenu_qr stays in the enum (a Postgres enum value
-- cannot be dropped): old rows stay readable and refundable; new code never
-- writes it. Its own migration: a new enum value can't be used in the
-- transaction that adds it. Sorts after 20261012140000_money_bigint.

-- AlterEnum
ALTER TYPE "PaymentMethod" ADD VALUE IF NOT EXISTS 'raast';

-- AlterEnum
ALTER TYPE "PaymentGateway" ADD VALUE IF NOT EXISTS 'raast';

-- AlterEnum
ALTER TYPE "ConnectorKind" ADD VALUE IF NOT EXISTS 'raast';
