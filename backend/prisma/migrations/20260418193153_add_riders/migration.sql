-- CreateEnum
CREATE TYPE "RiderStatus" AS ENUM ('available', 'busy', 'offline');

-- CreateEnum
CREATE TYPE "VehicleType" AS ENUM ('bike', 'car', 'bicycle', 'foot');

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "riderId" TEXT;

-- CreateTable
CREATE TABLE "riders" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "vehicleType" "VehicleType" NOT NULL DEFAULT 'bike',
    "status" "RiderStatus" NOT NULL DEFAULT 'offline',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "totalDeliveries" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "riders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "riders_phone_key" ON "riders"("phone");

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_riderId_fkey" FOREIGN KEY ("riderId") REFERENCES "riders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
