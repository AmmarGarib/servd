-- Reservation expansion: deposits, confirmation tokens, reminders, blockouts,
-- service hours, guest tags.

ALTER TABLE "reservations" ADD COLUMN "depositCents"      INTEGER       NOT NULL DEFAULT 0;
ALTER TABLE "reservations" ADD COLUMN "depositRef"        TEXT;
ALTER TABLE "reservations" ADD COLUMN "confirmToken"      TEXT;
ALTER TABLE "reservations" ADD COLUMN "confirmedAt"       TIMESTAMP(3);
ALTER TABLE "reservations" ADD COLUMN "reminder24hSentAt" TIMESTAMP(3);
ALTER TABLE "reservations" ADD COLUMN "reminder2hSentAt"  TIMESTAMP(3);
CREATE UNIQUE INDEX "reservations_confirmToken_key"   ON "reservations" ("confirmToken");
CREATE INDEX        "reservations_reminder24h_idx"   ON "reservations" ("reminder24hSentAt");

CREATE TYPE "BlockoutKind" AS ENUM ('closure', 'private_event', 'reduced_capacity', 'custom');

CREATE TABLE "concept_blockouts" (
  "id"          TEXT          NOT NULL,
  "conceptId"   TEXT          NOT NULL,
  "kind"        "BlockoutKind" NOT NULL DEFAULT 'closure',
  "startTime"   TIMESTAMP(3)  NOT NULL,
  "endTime"     TIMESTAMP(3)  NOT NULL,
  "capacityCap" INTEGER,
  "reason"      TEXT,
  "createdById" TEXT,
  "createdAt"   TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3)  NOT NULL,
  CONSTRAINT "concept_blockouts_pkey"    PRIMARY KEY ("id"),
  CONSTRAINT "concept_blockouts_conceptFk" FOREIGN KEY ("conceptId") REFERENCES "concepts"("id") ON DELETE NO ACTION
);
CREATE INDEX "concept_blockouts_concept_startTime_idx" ON "concept_blockouts" ("conceptId", "startTime");

CREATE TABLE "service_hours" (
  "id"           TEXT          NOT NULL,
  "conceptId"    TEXT          NOT NULL,
  "dayOfWeek"    INTEGER       NOT NULL,
  "openMin"      INTEGER       NOT NULL,
  "closeMin"     INTEGER       NOT NULL,
  "isReservable" BOOLEAN       NOT NULL DEFAULT TRUE,
  "createdAt"    TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3)  NOT NULL,
  CONSTRAINT "service_hours_pkey"      PRIMARY KEY ("id"),
  CONSTRAINT "service_hours_conceptFk" FOREIGN KEY ("conceptId") REFERENCES "concepts"("id") ON DELETE NO ACTION
);
CREATE UNIQUE INDEX "service_hours_concept_dow_open_key" ON "service_hours" ("conceptId", "dayOfWeek", "openMin");

CREATE TABLE "guest_tags" (
  "id"          TEXT          NOT NULL,
  "customerId"  TEXT          NOT NULL,
  "label"       TEXT          NOT NULL,
  "color"       TEXT,
  "createdById" TEXT,
  "createdAt"   TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "guest_tags_pkey"      PRIMARY KEY ("id"),
  CONSTRAINT "guest_tags_customerFk" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE
);
CREATE INDEX "guest_tags_customerId_idx" ON "guest_tags" ("customerId");
