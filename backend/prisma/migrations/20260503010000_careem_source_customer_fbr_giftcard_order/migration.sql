-- Migration: add careem OrderSource, customer FBR fields, gift card → order relation

-- Add 'careem' to OrderSource enum
ALTER TYPE "OrderSource" ADD VALUE IF NOT EXISTS 'careem';

-- Add FBR-related fields to customers (BuyerNTN and BuyerCNIC for invoices)
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "ntn" TEXT;
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "cnic" TEXT;

-- Add orderId index on gift_card_redemptions (back-relation for Order.giftCardRedemptions)
CREATE INDEX IF NOT EXISTS "gift_card_redemptions_orderId_idx" ON "gift_card_redemptions"("orderId");
