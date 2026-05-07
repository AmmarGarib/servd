-- Customer saved addresses (labelled delivery locations)
CREATE TABLE "customer_addresses" (
  "id"         TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "label"      TEXT NOT NULL,
  "address"    TEXT NOT NULL,
  "lat"        DOUBLE PRECISION,
  "lng"        DOUBLE PRECISION,
  "isDefault"  BOOLEAN NOT NULL DEFAULT false,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "customer_addresses_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "customer_addresses_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "customer_addresses_customerId_idx" ON "customer_addresses" ("customerId");
