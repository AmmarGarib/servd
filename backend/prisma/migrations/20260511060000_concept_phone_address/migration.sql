-- Add phone and address fields to Concept for storefront /visit page
ALTER TABLE "concepts" ADD COLUMN IF NOT EXISTS "phone" TEXT;
ALTER TABLE "concepts" ADD COLUMN IF NOT EXISTS "address" TEXT;
