-- Concept-scoped access for non-admin staff. Empty array means no restriction
-- is checked (admin/manager bypass via role check); non-admin roles must have
-- explicit concept IDs to access concept-scoped resources.
ALTER TABLE "users" ADD COLUMN "conceptIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
