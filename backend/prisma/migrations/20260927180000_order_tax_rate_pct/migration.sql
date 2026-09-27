-- The GST rate each order was priced at (owner decision 9); old rows stay null.
ALTER TABLE "orders" ADD COLUMN "taxRatePct" DOUBLE PRECISION;
