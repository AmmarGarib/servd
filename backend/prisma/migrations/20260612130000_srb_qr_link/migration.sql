-- SRB invoice-verification QR link, returned by the SRB POS gateway alongside
-- the SRB invoice id. Must be embedded as a QR code on the receipt.
ALTER TABLE "orders" ADD COLUMN "srbQrCodeLink" TEXT;
