-- Floor plan + reservations
CREATE TYPE "TableShape"        AS ENUM ('rectangle', 'square', 'round', 'banquette', 'counter', 'barstool');
CREATE TYPE "ReservationStatus" AS ENUM ('booked', 'confirmed', 'seated', 'completed', 'no_show', 'cancelled');
CREATE TYPE "ReservationSource" AS ENUM ('staff', 'website', 'phone', 'walkin');

-- Floors
CREATE TABLE "floors" (
  "id"            TEXT          NOT NULL,
  "conceptId"     TEXT          NOT NULL,
  "name"          TEXT          NOT NULL,
  "displayOrder"  INTEGER       NOT NULL DEFAULT 0,
  "width"         INTEGER       NOT NULL DEFAULT 1200,
  "height"        INTEGER       NOT NULL DEFAULT 800,
  "backgroundUrl" TEXT,
  "isActive"      BOOLEAN       NOT NULL DEFAULT TRUE,
  "createdAt"     TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3)  NOT NULL,
  "deletedAt"     TIMESTAMP(3),
  CONSTRAINT "floors_pkey"        PRIMARY KEY ("id"),
  CONSTRAINT "floors_conceptFk"   FOREIGN KEY ("conceptId") REFERENCES "concepts"("id") ON DELETE NO ACTION
);
CREATE INDEX "floors_conceptId_displayOrder_idx" ON "floors" ("conceptId", "displayOrder");

-- Extend Table with positioning fields
ALTER TABLE "tables" ADD COLUMN "floorId"  TEXT;
ALTER TABLE "tables" ADD COLUMN "shape"    "TableShape" NOT NULL DEFAULT 'rectangle';
ALTER TABLE "tables" ADD COLUMN "x"        INTEGER      NOT NULL DEFAULT 40;
ALTER TABLE "tables" ADD COLUMN "y"        INTEGER      NOT NULL DEFAULT 40;
ALTER TABLE "tables" ADD COLUMN "width"    INTEGER      NOT NULL DEFAULT 120;
ALTER TABLE "tables" ADD COLUMN "height"   INTEGER      NOT NULL DEFAULT 80;
ALTER TABLE "tables" ADD COLUMN "rotation" INTEGER      NOT NULL DEFAULT 0;
ALTER TABLE "tables" ADD CONSTRAINT "tables_floorFk"
  FOREIGN KEY ("floorId") REFERENCES "floors"("id") ON DELETE SET NULL;
CREATE INDEX "tables_conceptId_floorId_idx" ON "tables" ("conceptId", "floorId");

-- Reservations
CREATE TABLE "reservations" (
  "id"           TEXT                NOT NULL,
  "conceptId"    TEXT                NOT NULL,
  "customerId"   TEXT,
  "tableId"      TEXT,
  "partySize"    INTEGER             NOT NULL,
  "startTime"    TIMESTAMP(3)        NOT NULL,
  "endTime"      TIMESTAMP(3)        NOT NULL,
  "status"       "ReservationStatus" NOT NULL DEFAULT 'booked',
  "source"       "ReservationSource" NOT NULL DEFAULT 'staff',
  "guestName"    TEXT                NOT NULL,
  "guestPhone"   TEXT,
  "guestEmail"   TEXT,
  "notes"        TEXT,
  "isVip"        BOOLEAN             NOT NULL DEFAULT FALSE,
  "waitlist"     BOOLEAN             NOT NULL DEFAULT FALSE,
  "seatedAt"     TIMESTAMP(3),
  "completedAt"  TIMESTAMP(3),
  "cancelledAt"  TIMESTAMP(3),
  "cancelReason" TEXT,
  "createdById"  TEXT,
  "createdAt"    TIMESTAMP(3)        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3)        NOT NULL,
  CONSTRAINT "reservations_pkey"        PRIMARY KEY ("id"),
  CONSTRAINT "reservations_conceptFk"   FOREIGN KEY ("conceptId")  REFERENCES "concepts"("id")  ON DELETE NO ACTION,
  CONSTRAINT "reservations_customerFk"  FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE SET NULL,
  CONSTRAINT "reservations_tableFk"     FOREIGN KEY ("tableId")    REFERENCES "tables"("id")    ON DELETE SET NULL
);
CREATE INDEX "reservations_concept_startTime_idx" ON "reservations" ("conceptId", "startTime");
CREATE INDEX "reservations_table_startTime_idx"   ON "reservations" ("tableId", "startTime");
CREATE INDEX "reservations_status_startTime_idx"  ON "reservations" ("status", "startTime");
