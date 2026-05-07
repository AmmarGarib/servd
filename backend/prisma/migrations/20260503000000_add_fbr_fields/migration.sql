-- Migration: add FBR PRAL POS fields
-- FBR SRO 1307(I)/2022 — Tier-1 real-time invoice submission

-- POSID registered with FBR per concept
ALTER TABLE "concepts" ADD COLUMN "fbrPosId" INTEGER;

-- FBR-assigned USIN returned after successful invoice submission
ALTER TABLE "orders" ADD COLUMN "fbrInvoiceNumber" TEXT;
