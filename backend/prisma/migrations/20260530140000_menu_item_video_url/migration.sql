-- Add an optional looping-video URL to menu items so operators can
-- show video clips on the storefront menu instead of (or alongside)
-- a still image. Both columns are nullable — storefront prefers
-- videoUrl over imageUrl, falling back to the gradient placeholder
-- when neither is set.

ALTER TABLE menu_items
  ADD COLUMN IF NOT EXISTS "videoUrl" TEXT;
