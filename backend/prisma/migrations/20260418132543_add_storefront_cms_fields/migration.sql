-- AlterTable
ALTER TABLE "concepts" ADD COLUMN     "announcementBanner" TEXT,
ADD COLUMN     "heroTagline" TEXT,
ADD COLUMN     "storefrontVisible" BOOLEAN NOT NULL DEFAULT true;
