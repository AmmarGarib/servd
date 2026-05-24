-- Baseline migration — full schema, generated from prisma/schema.prisma.
--
-- This replaces the previous 70-migration history, which could not be replayed
-- onto a fresh database: ~60 tables were only ever created via `prisma db push`
-- (never written as migrations), and two individual migrations were broken.
-- schema.prisma is the single source of truth, so the history was squashed into
-- this one baseline.
--
-- The three objects re-attached below are raw SQL that schema.prisma cannot
-- express: the btree_gist extension, the reservation no-overlap exclusion
-- constraint, and the recipe-ingredient mutual-exclusion CHECK constraint.
--
-- Existing databases (production/staging): mark as already applied with
--   npx prisma migrate resolve --applied 0_init
-- Fresh databases (CI / tests / new devs): `prisma migrate deploy` builds it all.

-- Required by the reservation exclusion constraint at the end of this file.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- CreateEnum
CREATE TYPE "ConceptType" AS ENUM ('restaurant', 'digital', 'cart');

-- CreateEnum
CREATE TYPE "OrderSource" AS ENUM ('servd', 'foodpanda', 'careem', 'pos', 'cart', 'manual');

-- CreateEnum
CREATE TYPE "FulfilmentType" AS ENUM ('dine_in', 'takeout', 'delivery');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('received', 'confirmed', 'preparing', 'ready', 'completed', 'cancelled', 'rejected', 'refunded');

-- CreateEnum
CREATE TYPE "ItemStatus" AS ENUM ('pending', 'preparing', 'ready', 'bumped', 'held', 'recalled', 'voided');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('admin', 'manager', 'management', 'foh_management', 'boh_management', 'foh', 'boh', 'kitchen', 'expediter', 'cashier', 'procurement', 'marketing', 'finance', 'hr');

-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('pending', 'active', 'suspended');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('cash', 'card', 'keenu_qr', 'split', 'comp');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('pending', 'paid', 'failed', 'refunded');

-- CreateEnum
CREATE TYPE "PaymentGateway" AS ENUM ('keenu', 'jazzcash', 'easypaisa', 'none');

-- CreateEnum
CREATE TYPE "ShiftStatus" AS ENUM ('open', 'closed');

-- CreateEnum
CREATE TYPE "LoyaltyTxType" AS ENUM ('earn', 'redeem', 'expire', 'adjustment');

-- CreateEnum
CREATE TYPE "BroadcastStatus" AS ENUM ('draft', 'scheduled', 'sent', 'failed');

-- CreateEnum
CREATE TYPE "TriggerType" AS ENUM ('birthday', 'winback', 'loyalty_tier', 'custom');

-- CreateEnum
CREATE TYPE "RiderStatus" AS ENUM ('available', 'busy', 'offline');

-- CreateEnum
CREATE TYPE "VehicleType" AS ENUM ('bike', 'car', 'bicycle', 'foot');

-- CreateEnum
CREATE TYPE "ComplaintStatus" AS ENUM ('open', 'in_progress', 'resolved', 'closed');

-- CreateEnum
CREATE TYPE "ComplaintPriority" AS ENUM ('low', 'medium', 'high', 'urgent');

-- CreateEnum
CREATE TYPE "AccountType" AS ENUM ('asset', 'liability', 'equity', 'revenue', 'expense');

-- CreateEnum
CREATE TYPE "JournalEntryType" AS ENUM ('debit', 'credit');

-- CreateEnum
CREATE TYPE "TaxClassification" AS ENUM ('standard', 'zero_rated', 'exempt', 'custom');

-- CreateEnum
CREATE TYPE "TableShape" AS ENUM ('rectangle', 'square', 'round', 'banquette', 'counter', 'barstool');

-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('booked', 'confirmed', 'seated', 'completed', 'no_show', 'cancelled');

-- CreateEnum
CREATE TYPE "ReservationSource" AS ENUM ('staff', 'website', 'phone', 'walkin');

-- CreateEnum
CREATE TYPE "BlockoutKind" AS ENUM ('closure', 'private_event', 'reduced_capacity', 'custom');

-- CreateEnum
CREATE TYPE "GiftCardStatus" AS ENUM ('active', 'redeemed_full', 'expired', 'voided');

-- CreateEnum
CREATE TYPE "CashMovementType" AS ENUM ('drop', 'add', 'payout', 'payin');

-- CreateEnum
CREATE TYPE "PayrollRunStatus" AS ENUM ('draft', 'posted', 'paid');

-- CreateEnum
CREATE TYPE "TipPoolStatus" AS ENUM ('draft', 'posted', 'paid');

-- CreateEnum
CREATE TYPE "GroupOrderStatus" AS ENUM ('open', 'locked', 'submitted', 'cancelled');

-- CreateEnum
CREATE TYPE "RecipeKind" AS ENUM ('plate', 'prep', 'component');

-- CreateEnum
CREATE TYPE "RecipePhase" AS ENUM ('prep_mep', 'prep_mop', 'service_cook', 'service_assemble');

-- CreateEnum
CREATE TYPE "StepRunStatus" AS ENUM ('pending', 'waiting', 'preparing', 'done', 'voided');

-- CreateEnum
CREATE TYPE "AllocationDriver" AS ENUM ('fixed_pct', 'revenue_share');

-- CreateEnum
CREATE TYPE "InvoiceType" AS ENUM ('invoice', 'credit_note');

-- CreateEnum
CREATE TYPE "AnalyticsEventType" AS ENUM ('page_view', 'concept_view', 'item_view', 'item_added', 'item_removed', 'cart_viewed', 'checkout_started', 'checkout_step', 'checkout_abandoned', 'order_placed', 'search', 'filter_applied', 'concept_switched', 'promo_applied', 'promo_failed');

-- CreateEnum
CREATE TYPE "ContentEventType" AS ENUM ('social_post', 'menu_change', 'seasonal_ingredient', 'deal', 'shoot', 'event_promo', 'reminder', 'task');

-- CreateEnum
CREATE TYPE "ContentEventStatus" AS ENUM ('draft', 'scheduled', 'live', 'done', 'cancelled');

-- CreateEnum
CREATE TYPE "SocialPlatform" AS ENUM ('instagram', 'facebook', 'tiktok');

-- CreateEnum
CREATE TYPE "SocialPostStatus" AS ENUM ('draft', 'scheduled', 'published', 'failed');

-- CreateEnum
CREATE TYPE "ComponentType" AS ENUM ('hero', 'supporting', 'trim_waste');

-- CreateEnum
CREATE TYPE "DomainStatus" AS ENUM ('pending', 'verified', 'active', 'failed', 'disabled');

-- CreateEnum
CREATE TYPE "ExceptionSeverity" AS ENUM ('low', 'medium', 'high', 'critical');

-- CreateEnum
CREATE TYPE "ExceptionStatus" AS ENUM ('open', 'acknowledged', 'resolved', 'dismissed');

-- CreateEnum
CREATE TYPE "KitchenStaffRole" AS ENUM ('head_chef', 'sous_chef', 'cdp', 'demi_chef', 'commis', 'kitchen_helper', 'dishwasher', 'baker', 'tandoor_grill_cook');

-- CreateEnum
CREATE TYPE "SkillLevel" AS ENUM ('unskilled', 'semi_skilled', 'skilled', 'highly_skilled');

-- CreateEnum
CREATE TYPE "EmploymentType" AS ENUM ('permanent', 'probationary', 'temporary', 'contract');

-- CreateEnum
CREATE TYPE "KitchenStaffStatus" AS ENUM ('active', 'on_leave', 'terminated');

-- CreateEnum
CREATE TYPE "PositionStatus" AS ENUM ('open', 'filled', 'frozen', 'archived');

-- CreateEnum
CREATE TYPE "ContributionCategory" AS ENUM ('head_office', 'commissary', 'shared_services', 'other');

-- CreateTable
CREATE TABLE "concepts" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "type" "ConceptType" NOT NULL,
    "description" TEXT,
    "logoUrl" TEXT,
    "primaryColor" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "forecastPortionsPerMonth" INTEGER NOT NULL DEFAULT 0,
    "taxRate" DOUBLE PRECISION NOT NULL DEFAULT 17,
    "taxRateCash" DOUBLE PRECISION NOT NULL DEFAULT 15,
    "taxRateCard" DOUBLE PRECISION NOT NULL DEFAULT 8,
    "storefrontVisible" BOOLEAN NOT NULL DEFAULT true,
    "heroTagline" TEXT,
    "announcementBanner" TEXT,
    "storefrontLayout" JSONB,
    "reservationsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "conceptStatement" TEXT,
    "cuisine" TEXT,
    "heroProduct" TEXT,
    "anchoringExperience" TEXT,
    "targetCustomer" TEXT,
    "priceTier" TEXT,
    "daypartFocus" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "competitors" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "differentiator" TEXT,
    "brandVoice" TEXT,
    "phone" TEXT,
    "address" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "deliveryRadiusKm" DOUBLE PRECISION NOT NULL DEFAULT 5,
    "foodpandaCommissionRate" DOUBLE PRECISION NOT NULL DEFAULT 0.25,
    "strn" TEXT,
    "ntn" TEXT,
    "province" TEXT,
    "invoiceLegalName" TEXT,
    "invoiceAddress" TEXT,
    "invoicePrefix" TEXT,
    "fbrPosId" INTEGER,
    "srbPosId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "concepts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stations" (
    "id" TEXT NOT NULL,
    "conceptId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "stations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "categories" (
    "id" TEXT NOT NULL,
    "conceptId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "timeRestrictionStart" TEXT,
    "timeRestrictionEnd" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "menu_items" (
    "id" TEXT NOT NULL,
    "conceptId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "name_urdu" TEXT,
    "description" TEXT,
    "instructions" TEXT,
    "instructions_urdu" TEXT,
    "priceCents" INTEGER NOT NULL,
    "imageUrl" TEXT,
    "isAvailable" BOOLEAN NOT NULL DEFAULT true,
    "portionsAvailable" INTEGER,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "stationId" TEXT,
    "taxClassification" "TaxClassification" NOT NULL DEFAULT 'standard',
    "overrideTaxRate" DOUBLE PRECISION,
    "allergens" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "dietary" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "spiceLevel" INTEGER,
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "menu_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "modifier_groups" (
    "id" TEXT NOT NULL,
    "menuItemId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "minSelect" INTEGER NOT NULL DEFAULT 0,
    "maxSelect" INTEGER NOT NULL DEFAULT 1,
    "isRequired" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "modifier_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "modifiers" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "priceDeltaCents" INTEGER NOT NULL DEFAULT 0,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "allergens" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "modifiers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tables" (
    "id" TEXT NOT NULL,
    "conceptId" TEXT NOT NULL,
    "floorId" TEXT,
    "label" TEXT NOT NULL,
    "capacity" INTEGER NOT NULL DEFAULT 4,
    "floorSection" TEXT,
    "status" TEXT NOT NULL DEFAULT 'available',
    "shape" "TableShape" NOT NULL DEFAULT 'rectangle',
    "x" INTEGER NOT NULL DEFAULT 40,
    "y" INTEGER NOT NULL DEFAULT 40,
    "width" INTEGER NOT NULL DEFAULT 120,
    "height" INTEGER NOT NULL DEFAULT 80,
    "rotation" INTEGER NOT NULL DEFAULT 0,
    "currentPartySize" INTEGER,
    "currentOrderId" TEXT,
    "estimatedDepartureAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "tables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "floors" (
    "id" TEXT NOT NULL,
    "conceptId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "width" INTEGER NOT NULL DEFAULT 1200,
    "height" INTEGER NOT NULL DEFAULT 800,
    "backgroundUrl" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "floors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reservations" (
    "id" TEXT NOT NULL,
    "conceptId" TEXT NOT NULL,
    "customerId" TEXT,
    "tableId" TEXT,
    "partySize" INTEGER NOT NULL,
    "startTime" TIMESTAMP(3) NOT NULL,
    "endTime" TIMESTAMP(3) NOT NULL,
    "status" "ReservationStatus" NOT NULL DEFAULT 'booked',
    "source" "ReservationSource" NOT NULL DEFAULT 'staff',
    "guestName" TEXT NOT NULL,
    "guestPhone" TEXT,
    "guestEmail" TEXT,
    "notes" TEXT,
    "isVip" BOOLEAN NOT NULL DEFAULT false,
    "waitlist" BOOLEAN NOT NULL DEFAULT false,
    "depositCents" INTEGER NOT NULL DEFAULT 0,
    "depositRef" TEXT,
    "confirmToken" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "reminder24hSentAt" TIMESTAMP(3),
    "reminder2hSentAt" TIMESTAMP(3),
    "seatedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "promotionToken" TEXT,
    "promotionExpiresAt" TIMESTAMP(3),
    "promotionOfferedStartTime" TIMESTAMP(3),
    "promotionOfferedEndTime" TIMESTAMP(3),
    "promotionOfferedTableId" TEXT,
    "promotedFromWaitlistAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "concept_blockouts" (
    "id" TEXT NOT NULL,
    "conceptId" TEXT NOT NULL,
    "kind" "BlockoutKind" NOT NULL DEFAULT 'closure',
    "startTime" TIMESTAMP(3) NOT NULL,
    "endTime" TIMESTAMP(3) NOT NULL,
    "capacityCap" INTEGER,
    "reason" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "concept_blockouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_hours" (
    "id" TEXT NOT NULL,
    "conceptId" TEXT NOT NULL,
    "dayOfWeek" INTEGER NOT NULL,
    "openMin" INTEGER NOT NULL,
    "closeMin" INTEGER NOT NULL,
    "isReservable" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "service_hours_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gift_cards" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "issuedAmountCents" INTEGER NOT NULL,
    "balanceCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'PKR',
    "status" "GiftCardStatus" NOT NULL DEFAULT 'active',
    "expiresAt" TIMESTAMP(3),
    "buyerCustomerId" TEXT,
    "buyerEmail" TEXT,
    "recipientName" TEXT,
    "recipientEmail" TEXT,
    "message" TEXT,
    "issuedById" TEXT,
    "conceptId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "voidedAt" TIMESTAMP(3),
    "voidReason" TEXT,

    CONSTRAINT "gift_cards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gift_card_redemptions" (
    "id" TEXT NOT NULL,
    "giftCardId" TEXT NOT NULL,
    "orderId" TEXT,
    "amountCents" INTEGER NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "redeemedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "redeemedById" TEXT,

    CONSTRAINT "gift_card_redemptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guest_tags" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "color" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "guest_tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "password" TEXT NOT NULL,
    "pin" TEXT,
    "role" "UserRole" NOT NULL DEFAULT 'kitchen',
    "jobTitle" TEXT,
    "accountStatus" "AccountStatus" NOT NULL DEFAULT 'active',
    "signupReason" TEXT,
    "conceptIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "stationIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "permissionAllow" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "permissionDeny" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "moduleAllow" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "moduleDeny" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "hourlyRateCents" INTEGER,
    "wageAccountCode" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shifts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "locationId" TEXT,
    "status" "ShiftStatus" NOT NULL DEFAULT 'open',
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "openingFloatCents" INTEGER NOT NULL DEFAULT 0,
    "closingFloatCents" INTEGER,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shifts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cash_movements" (
    "id" TEXT NOT NULL,
    "shiftId" TEXT NOT NULL,
    "type" "CashMovementType" NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "recordedById" TEXT NOT NULL,
    "managerOverridePin" TEXT,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cash_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expo_push_tokens" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "device" TEXT NOT NULL,
    "locationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "expo_push_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clock_logs" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "selfieUrl" TEXT,
    "geofenceMatched" BOOLEAN,
    "geofenceDistanceM" DOUBLE PRECISION,
    "ipAddress" TEXT,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "clock_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_runs" (
    "id" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "status" "PayrollRunStatus" NOT NULL DEFAULT 'draft',
    "totalGrossCents" INTEGER NOT NULL DEFAULT 0,
    "postedAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "createdById" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payroll_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_run_lines" (
    "id" TEXT NOT NULL,
    "payrollRunId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "userName" TEXT NOT NULL,
    "hoursWorked" DOUBLE PRECISION NOT NULL,
    "hourlyRateCents" INTEGER NOT NULL,
    "grossCents" INTEGER NOT NULL,
    "wageAccountCode" TEXT NOT NULL,
    "adjustmentCents" INTEGER NOT NULL DEFAULT 0,
    "netCents" INTEGER NOT NULL,
    "notes" TEXT,

    CONSTRAINT "payroll_run_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customers" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "marketingOptIn" BOOLEAN NOT NULL DEFAULT false,
    "ntn" TEXT,
    "cnic" TEXT,
    "birthdayMmDd" TEXT,
    "firstOrderAt" TIMESTAMP(3),
    "lastOrderAt" TIMESTAMP(3),
    "totalSpentCents" INTEGER NOT NULL DEFAULT 0,
    "preferredConceptId" TEXT,
    "walletBalance" INTEGER NOT NULL DEFAULT 0,
    "referralCode" TEXT,
    "referredById" TEXT,
    "referredAt" TIMESTAMP(3),
    "referralRewardCreditedAt" TIMESTAMP(3),
    "password" TEXT,
    "phoneVerifiedAt" TIMESTAMP(3),
    "isBlacklisted" BOOLEAN NOT NULL DEFAULT false,
    "blacklistReason" TEXT,
    "noShowCount" INTEGER NOT NULL DEFAULT 0,
    "complaintCount" INTEGER NOT NULL DEFAULT 0,
    "reviewCount" INTEGER NOT NULL DEFAULT 0,
    "strikeCount" INTEGER NOT NULL DEFAULT 0,
    "bannedAt" TIMESTAMP(3),
    "avgReviewRating" DOUBLE PRECISION,
    "lastVisitAt" TIMESTAMP(3),
    "lastComplaintAt" TIMESTAMP(3),
    "lastReviewedAt" TIMESTAMP(3),
    "lastNoShowAt" TIMESTAMP(3),
    "staffNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_strikes" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "sourceType" TEXT,
    "sourceId" TEXT,
    "severity" INTEGER NOT NULL DEFAULT 1,
    "reason" TEXT,
    "expiresAt" TIMESTAMP(3),
    "reversedAt" TIMESTAMP(3),
    "reversedById" TEXT,
    "reversalReason" TEXT,
    "recordedById" TEXT,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_strikes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_bans" (
    "id" TEXT NOT NULL,
    "customerId" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "ipAddresses" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "deviceFingerprints" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "reason" TEXT NOT NULL,
    "bannedById" TEXT,
    "bannedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "liftedAt" TIMESTAMP(3),
    "liftedById" TEXT,
    "liftReason" TEXT,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "customer_bans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_conversations" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "subject" TEXT,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "sourceRefId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_messages" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "fromStaff" BOOLEAN NOT NULL,
    "senderId" TEXT,
    "body" TEXT NOT NULL,
    "mediaUrl" TEXT,
    "seenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "channel" TEXT NOT NULL DEFAULT 'web_portal',
    "externalMessageId" TEXT,
    "inboundFromAddress" TEXT,

    CONSTRAINT "customer_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_addresses" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_addresses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trigger_logs" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "triggerType" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trigger_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tier_configs" (
    "id" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "displayName" TEXT,
    "rank" INTEGER NOT NULL DEFAULT 0,
    "isPaid" BOOLEAN NOT NULL DEFAULT false,
    "monthlyPriceCents" INTEGER,
    "unlockSpendCents" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "alwaysFreeDelivery" BOOLEAN NOT NULL DEFAULT false,
    "freeDeliveryAboveCents" INTEGER,
    "birthdayDiscountPct" INTEGER,
    "priorityReservationDays" INTEGER,
    "waitlistPriority" BOOLEAN NOT NULL DEFAULT false,
    "monthlyCompCents" INTEGER,
    "earlyMenuAccess" BOOLEAN NOT NULL DEFAULT false,
    "freeBirthdayItem" BOOLEAN NOT NULL DEFAULT false,
    "customPerks" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tier_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feedback_entries" (
    "id" TEXT NOT NULL,
    "customerId" TEXT,
    "conceptId" TEXT,
    "kind" TEXT NOT NULL,
    "score" INTEGER,
    "comment" TEXT,
    "context" JSONB,
    "source" TEXT NOT NULL DEFAULT 'storefront',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feedback_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "magic_links" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "magic_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "source" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payloadHash" TEXT,

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("source","eventId")
);

-- CreateTable
CREATE TABLE "phone_otps" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "customerId" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "consumedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "phone_otps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loyalty_accounts" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "pointsBalance" INTEGER NOT NULL DEFAULT 0,
    "lifetimePoints" INTEGER NOT NULL DEFAULT 0,
    "tier" TEXT NOT NULL DEFAULT 'bronze',
    "stampCounts" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "loyalty_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loyalty_transactions" (
    "id" TEXT NOT NULL,
    "loyaltyAccountId" TEXT NOT NULL,
    "orderId" TEXT,
    "type" "LoyaltyTxType" NOT NULL,
    "pointsDelta" INTEGER NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "loyalty_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" TEXT NOT NULL,
    "conceptId" TEXT NOT NULL,
    "locationId" TEXT,
    "source" "OrderSource" NOT NULL,
    "fulfilmentType" "FulfilmentType" NOT NULL DEFAULT 'dine_in',
    "externalId" TEXT,
    "status" "OrderStatus" NOT NULL DEFAULT 'received',
    "tableId" TEXT,
    "customerId" TEXT,
    "customerName" TEXT,
    "posStaffId" TEXT,
    "shiftId" TEXT,
    "riderId" TEXT,
    "promoCodeId" TEXT,
    "totalCents" INTEGER NOT NULL,
    "discountCents" INTEGER NOT NULL DEFAULT 0,
    "promoDiscountCents" INTEGER NOT NULL DEFAULT 0,
    "walletAmountCents" INTEGER NOT NULL DEFAULT 0,
    "taxCents" INTEGER NOT NULL DEFAULT 0,
    "serviceChargeCents" INTEGER NOT NULL DEFAULT 0,
    "tipCents" INTEGER NOT NULL DEFAULT 0,
    "deliveryNotes" TEXT,
    "estimatedPickup" TIMESTAMP(3),
    "scheduledFor" TIMESTAMP(3),
    "isPreOrder" BOOLEAN NOT NULL DEFAULT false,
    "deliveryOtp" TEXT,
    "deliveryOtpVerifiedAt" TIMESTAMP(3),
    "deliveryOtpAttempts" INTEGER NOT NULL DEFAULT 0,
    "placedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "reviewPromptSentAt" TIMESTAMP(3),
    "curbsideVehicle" TEXT,
    "curbsidePlate" TEXT,
    "curbsideSpot" TEXT,
    "curbsideArrivedAt" TIMESTAMP(3),
    "curbsideRunnerOutAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancellationReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "fbrInvoiceNumber" TEXT,
    "srbInvoiceNumber" TEXT,
    "rawPayload" JSONB,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_items" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "menuItemId" TEXT,
    "stationId" TEXT,
    "externalItemId" TEXT,
    "name" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unitPriceCents" INTEGER NOT NULL,
    "status" "ItemStatus" NOT NULL DEFAULT 'pending',
    "notes" TEXT,
    "course" INTEGER,
    "firedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "voidedAt" TIMESTAMP(3),
    "voidReason" TEXT,
    "scheduledFireAt" TIMESTAMP(3),
    "bumpPhotoUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_item_modifiers" (
    "id" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "modifierId" TEXT,
    "name" TEXT NOT NULL,
    "priceDeltaCents" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "order_item_modifiers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "shiftId" TEXT,
    "method" "PaymentMethod" NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'pending',
    "gateway" "PaymentGateway" NOT NULL DEFAULT 'none',
    "gatewayRef" TEXT,
    "gatewayMeta" JSONB,
    "tenderedCents" INTEGER,
    "changeCents" INTEGER,
    "splitGroup" INTEGER,
    "splitLabel" TEXT,
    "processedAt" TIMESTAMP(3),
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "lastRetryAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tip_pools" (
    "id" TEXT NOT NULL,
    "conceptId" TEXT,
    "name" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "totalTipsCents" INTEGER NOT NULL DEFAULT 0,
    "status" "TipPoolStatus" NOT NULL DEFAULT 'draft',
    "postedAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tip_pools_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tip_pool_members" (
    "id" TEXT NOT NULL,
    "poolId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "userName" TEXT NOT NULL,
    "hoursWorked" DOUBLE PRECISION NOT NULL,
    "roleWeight" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "shareUnits" DOUBLE PRECISION NOT NULL,
    "shareCents" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,

    CONSTRAINT "tip_pool_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "group_orders" (
    "id" TEXT NOT NULL,
    "conceptId" TEXT NOT NULL,
    "initiatorCustomerId" TEXT,
    "initiatorName" TEXT NOT NULL,
    "shareCode" TEXT NOT NULL,
    "status" "GroupOrderStatus" NOT NULL DEFAULT 'open',
    "closingAt" TIMESTAMP(3),
    "orderId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "group_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "group_order_members" (
    "id" TEXT NOT NULL,
    "groupOrderId" TEXT NOT NULL,
    "customerId" TEXT,
    "displayName" TEXT NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "group_order_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "group_order_items" (
    "id" TEXT NOT NULL,
    "groupOrderId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "menuItemId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unitPriceCents" INTEGER NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "group_order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_items" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "name" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "parLevel" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "currentStock" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "unitCostCents" INTEGER,
    "yieldPct" DOUBLE PRECISION NOT NULL DEFAULT 100,
    "allergens" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "category" TEXT,
    "supplierId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "inventory_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "waste_logs" (
    "id" TEXT NOT NULL,
    "inventoryItemId" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "unit" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "estimatedCostCents" INTEGER,
    "photoUrl" TEXT,
    "approvedById" TEXT,
    "notes" TEXT,
    "recordedById" TEXT,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "waste_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "suppliers" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "name" TEXT NOT NULL,
    "category" TEXT,
    "assignedStaffId" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "whatsappPhone" TEXT,
    "address" TEXT,
    "taxId" TEXT,
    "notes" TEXT,
    "paymentTermsDays" INTEGER NOT NULL DEFAULT 30,
    "leadTimeDays" INTEGER,
    "openingBalanceCents" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recipes" (
    "id" TEXT NOT NULL,
    "kind" "RecipeKind" NOT NULL DEFAULT 'plate',
    "menuItemId" TEXT,
    "name" TEXT,
    "yieldGrams" DOUBLE PRECISION,
    "servings" INTEGER NOT NULL DEFAULT 1,
    "portionSizeG" DOUBLE PRECISION,
    "laborMinutes" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "steps" TEXT,
    "steps_urdu" TEXT,
    "qFactorPct" DOUBLE PRECISION NOT NULL DEFAULT 10,
    "targetProfitPct" DOUBLE PRECISION NOT NULL DEFAULT 25,
    "packagingPct" DOUBLE PRECISION NOT NULL DEFAULT 8,
    "actualSellingPriceCents" INTEGER,
    "category" TEXT,
    "photoUrl" TEXT,
    "seasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "seasonStart" TEXT,
    "seasonEnd" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recipes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recipe_ingredients" (
    "id" TEXT NOT NULL,
    "recipeId" TEXT NOT NULL,
    "inventoryItemId" TEXT,
    "prepRecipeId" TEXT,
    "quantity" DOUBLE PRECISION NOT NULL,
    "yieldPct" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "unit" TEXT NOT NULL,
    "notes" TEXT,

    CONSTRAINT "recipe_ingredients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recipe_steps" (
    "id" TEXT NOT NULL,
    "recipeId" TEXT NOT NULL,
    "phase" "RecipePhase" NOT NULL,
    "ordinal" INTEGER NOT NULL DEFAULT 0,
    "stationId" TEXT,
    "instruction" TEXT NOT NULL,
    "instructionUrdu" TEXT,
    "estimatedSeconds" INTEGER NOT NULL DEFAULT 60,
    "dependsOnIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recipe_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_item_steps" (
    "id" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "recipeStepId" TEXT NOT NULL,
    "stationId" TEXT,
    "status" "StepRunStatus" NOT NULL DEFAULT 'pending',
    "dependsOnStepIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "firedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "bumpedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "order_item_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_orders" (
    "id" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "orderDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expectedDate" TIMESTAMP(3),
    "receivedDate" TIMESTAMP(3),
    "reference" TEXT,
    "notes" TEXT,
    "totalCents" INTEGER NOT NULL DEFAULT 0,
    "createdBy" TEXT,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rejectedReason" TEXT,
    "sentAt" TIMESTAMP(3),
    "sentToEmail" TEXT,
    "cancelledById" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "purchase_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_order_lines" (
    "id" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "inventoryItemId" TEXT NOT NULL,
    "quantityOrdered" DOUBLE PRECISION NOT NULL,
    "quantityReceived" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "unitCostCents" INTEGER NOT NULL,
    "notes" TEXT,

    CONSTRAINT "purchase_order_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "po_activity_log" (
    "id" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "po_activity_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receiving_discrepancies" (
    "id" TEXT NOT NULL,
    "poLineId" TEXT NOT NULL,
    "expectedQty" DOUBLE PRECISION NOT NULL,
    "receivedQty" DOUBLE PRECISION NOT NULL,
    "reason" TEXT NOT NULL,
    "notes" TEXT,
    "recordedById" TEXT,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "receiving_discrepancies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "item_price_history" (
    "id" TEXT NOT NULL,
    "inventoryItemId" TEXT NOT NULL,
    "supplierId" TEXT,
    "oldCostCents" INTEGER,
    "newCostCents" INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    "poLineId" TEXT,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "item_price_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_bills" (
    "id" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "poId" TEXT,
    "billNumber" TEXT NOT NULL,
    "billDate" TIMESTAMP(3) NOT NULL,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "subtotalCents" INTEGER NOT NULL DEFAULT 0,
    "taxCents" INTEGER NOT NULL DEFAULT 0,
    "totalCents" INTEGER NOT NULL DEFAULT 0,
    "paidCents" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "attachmentUrl" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "voidedAt" TIMESTAMP(3),
    "voidReason" TEXT,

    CONSTRAINT "supplier_bills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_bill_lines" (
    "id" TEXT NOT NULL,
    "billId" TEXT NOT NULL,
    "inventoryItemId" TEXT,
    "poLineId" TEXT,
    "description" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "unitCostCents" INTEGER NOT NULL,
    "lineTotalCents" INTEGER NOT NULL,

    CONSTRAINT "supplier_bill_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_payments" (
    "id" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "paymentDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "method" TEXT NOT NULL,
    "reference" TEXT,
    "amountCents" INTEGER NOT NULL,
    "appliedCents" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_payment_applications" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "billId" TEXT NOT NULL,
    "amountAppliedCents" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_payment_applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounts" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "AccountType" NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_entries" (
    "id" TEXT NOT NULL,
    "reference" TEXT,
    "description" TEXT NOT NULL,
    "entryDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "postedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "journal_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_lines" (
    "id" TEXT NOT NULL,
    "journalEntryId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "type" "JournalEntryType" NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "memo" TEXT,

    CONSTRAINT "journal_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_statement_imports" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "accountCode" TEXT NOT NULL,
    "statementDate" TIMESTAMP(3) NOT NULL,
    "openingBalanceCents" INTEGER NOT NULL DEFAULT 0,
    "closingBalanceCents" INTEGER NOT NULL DEFAULT 0,
    "filename" TEXT,
    "importedById" TEXT,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bank_statement_imports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_statement_lines" (
    "id" TEXT NOT NULL,
    "importId" TEXT NOT NULL,
    "postedDate" TIMESTAMP(3) NOT NULL,
    "description" TEXT NOT NULL,
    "reference" TEXT,
    "amountCents" INTEGER NOT NULL,
    "matchStatus" TEXT NOT NULL DEFAULT 'unmatched',
    "matchedJournalLineId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bank_statement_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "foodpanda_settlements" (
    "id" TEXT NOT NULL,
    "settlementDate" TIMESTAMP(3) NOT NULL,
    "reference" TEXT,
    "expectedAmountCents" INTEGER NOT NULL,
    "actualAmountCents" INTEGER NOT NULL,
    "varianceCents" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'open',
    "notes" TEXT,
    "recordedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "foodpanda_settlements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cost_allocation_rules" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sourceAccountCode" TEXT NOT NULL,
    "driver" "AllocationDriver" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cost_allocation_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "allocation_rule_weights" (
    "id" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "conceptId" TEXT NOT NULL,
    "weightBps" INTEGER NOT NULL,
    "targetAccountCode" TEXT,

    CONSTRAINT "allocation_rule_weights_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cost_allocation_runs" (
    "id" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "totalAmountCents" INTEGER NOT NULL,
    "postedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "postedById" TEXT,

    CONSTRAINT "cost_allocation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_invoices" (
    "id" TEXT NOT NULL,
    "invoiceNumber" TEXT NOT NULL,
    "type" "InvoiceType" NOT NULL DEFAULT 'invoice',
    "orderId" TEXT NOT NULL,
    "conceptId" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sellerLegalName" TEXT NOT NULL,
    "sellerStrn" TEXT,
    "sellerNtn" TEXT,
    "sellerAddress" TEXT,
    "buyerName" TEXT,
    "buyerStrn" TEXT,
    "buyerNtn" TEXT,
    "buyerAddress" TEXT,
    "subtotalCents" INTEGER NOT NULL,
    "discountCents" INTEGER NOT NULL DEFAULT 0,
    "taxableValueCents" INTEGER NOT NULL,
    "fbrTaxCents" INTEGER NOT NULL DEFAULT 0,
    "provincialTaxCents" INTEGER NOT NULL DEFAULT 0,
    "serviceChargeCents" INTEGER NOT NULL DEFAULT 0,
    "tipCents" INTEGER NOT NULL DEFAULT 0,
    "totalCents" INTEGER NOT NULL,
    "originalInvoiceId" TEXT,
    "pdfUrl" TEXT,

    CONSTRAINT "tax_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_invoice_lines" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "unitPriceCents" INTEGER NOT NULL,
    "lineTotalCents" INTEGER NOT NULL,

    CONSTRAINT "tax_invoice_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_counters" (
    "conceptId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "nextValue" INTEGER NOT NULL,

    CONSTRAINT "invoice_counters_pkey" PRIMARY KEY ("conceptId")
);

-- CreateTable
CREATE TABLE "site_layouts" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT,
    "blocks" JSONB NOT NULL,
    "updatedById" TEXT,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "site_layouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT,
    "userId" TEXT,
    "userEmail" TEXT,
    "before" JSONB,
    "after" JSONB,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "period_locks" (
    "id" TEXT NOT NULL,
    "lockedThrough" TIMESTAMP(3) NOT NULL,
    "lockedBy" TEXT NOT NULL,
    "lockedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,

    CONSTRAINT "period_locks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "financial_entries" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "conceptId" TEXT NOT NULL,
    "locationId" TEXT,
    "channel" TEXT NOT NULL,
    "grossCents" INTEGER NOT NULL,
    "commissionCents" INTEGER NOT NULL DEFAULT 0,
    "discountCents" INTEGER NOT NULL DEFAULT 0,
    "taxCents" INTEGER NOT NULL DEFAULT 0,
    "netCents" INTEGER NOT NULL,
    "entryDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "financial_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "segments" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "filters" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "segments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaigns" (
    "id" TEXT NOT NULL,
    "segmentId" TEXT,
    "name" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "status" "BroadcastStatus" NOT NULL DEFAULT 'draft',
    "scheduledAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "recipientCount" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_sends" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'queued',
    "errorMsg" TEXT,

    CONSTRAINT "campaign_sends_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_triggers" (
    "id" TEXT NOT NULL,
    "type" "TriggerType" NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "config" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "automation_triggers_pkey" PRIMARY KEY ("id")
);

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
    "avgRating" DOUBLE PRECISION,
    "lastLat" DOUBLE PRECISION,
    "lastLng" DOUBLE PRECISION,
    "lastHeading" DOUBLE PRECISION,
    "lastAccuracy" DOUBLE PRECISION,
    "lastReportedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "riders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rider_ratings" (
    "id" TEXT NOT NULL,
    "riderId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rider_ratings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rider_locations" (
    "id" TEXT NOT NULL,
    "riderId" TEXT NOT NULL,
    "orderId" TEXT,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "heading" DOUBLE PRECISION,
    "accuracy" DOUBLE PRECISION,
    "speedMps" DOUBLE PRECISION,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rider_locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_reviews" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "customerId" TEXT,
    "conceptId" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "comment" TEXT,
    "source" TEXT NOT NULL DEFAULT 'storefront',
    "categoryRatings" JSONB,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isPositive" BOOLEAN NOT NULL DEFAULT false,
    "bonusPointsAwarded" INTEGER NOT NULL DEFAULT 0,
    "managerResponse" TEXT,
    "managerResponseAt" TIMESTAMP(3),
    "managerResponseById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "order_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_complaints" (
    "id" TEXT NOT NULL,
    "orderId" TEXT,
    "customerId" TEXT,
    "conceptId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "status" "ComplaintStatus" NOT NULL DEFAULT 'open',
    "priority" "ComplaintPriority" NOT NULL DEFAULT 'medium',
    "resolvedAt" TIMESTAMP(3),
    "resolution" TEXT,
    "followUpSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "order_complaints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "storefront_promos" (
    "id" TEXT NOT NULL,
    "emoji" TEXT NOT NULL DEFAULT '🔥',
    "badge" TEXT NOT NULL,
    "headline" TEXT NOT NULL,
    "sub" TEXT NOT NULL,
    "bg" TEXT NOT NULL DEFAULT '#c0392b',
    "shadow" TEXT NOT NULL DEFAULT '#922b21',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "storefront_promos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_transactions" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "description" TEXT,
    "orderId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promo_codes" (
    "id" TEXT NOT NULL,
    "conceptId" TEXT,
    "code" TEXT NOT NULL,
    "description" TEXT,
    "discountType" TEXT NOT NULL DEFAULT 'percentage',
    "discountValue" DOUBLE PRECISION NOT NULL,
    "minOrderCents" INTEGER,
    "maxDiscountCents" INTEGER,
    "maxUsageCount" INTEGER,
    "perCustomerLimit" INTEGER NOT NULL DEFAULT 1,
    "usedCount" INTEGER NOT NULL DEFAULT 0,
    "channel" TEXT NOT NULL DEFAULT 'both',
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "promo_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promo_code_usages" (
    "id" TEXT NOT NULL,
    "promoCodeId" TEXT NOT NULL,
    "customerId" TEXT,
    "orderId" TEXT NOT NULL,
    "discountCents" INTEGER NOT NULL,
    "usedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "promo_code_usages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "section_discounts" (
    "id" TEXT NOT NULL,
    "conceptId" TEXT,
    "categoryId" TEXT,
    "discountPercent" DOUBLE PRECISION NOT NULL,
    "deliveryTypes" TEXT[],
    "orderTypes" TEXT[],
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "section_discounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "abandoned_carts" (
    "id" TEXT NOT NULL,
    "cartId" TEXT NOT NULL,
    "conceptId" TEXT NOT NULL,
    "customerId" TEXT,
    "customerPhone" TEXT,
    "customerEmail" TEXT,
    "items" JSONB NOT NULL,
    "subtotalCents" INTEGER NOT NULL,
    "abandonedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recoveredAt" TIMESTAMP(3),
    "reminderSentAt" TIMESTAMP(3),

    CONSTRAINT "abandoned_carts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "qr_codes" (
    "id" TEXT NOT NULL,
    "conceptId" TEXT NOT NULL,
    "tableId" TEXT,
    "orderType" TEXT NOT NULL DEFAULT 'dine-in',
    "label" TEXT NOT NULL,
    "qrImageUrl" TEXT,
    "scanCount" INTEGER NOT NULL DEFAULT 0,
    "conversions" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "qr_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scheduled_shifts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "conceptId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "role" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scheduled_shifts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shift_swap_requests" (
    "id" TEXT NOT NULL,
    "shiftId" TEXT NOT NULL,
    "requestedByUserId" TEXT NOT NULL,
    "requestedFromUserId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shift_swap_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analytics_events" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "customerId" TEXT,
    "conceptId" TEXT,
    "event" "AnalyticsEventType" NOT NULL,
    "properties" JSONB,
    "url" TEXT,
    "referrer" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "analytics_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_segments" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "color" TEXT NOT NULL DEFAULT '#6366f1',
    "emoji" TEXT NOT NULL DEFAULT '👥',
    "memberCount" INTEGER NOT NULL DEFAULT 0,
    "lastComputedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_segments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_segment_memberships" (
    "customerId" TEXT NOT NULL,
    "segmentId" TEXT NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_segment_memberships_pkey" PRIMARY KEY ("customerId","segmentId")
);

-- CreateTable
CREATE TABLE "content_events" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "type" "ContentEventType" NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3),
    "allDay" BOOLEAN NOT NULL DEFAULT true,
    "status" "ContentEventStatus" NOT NULL DEFAULT 'draft',
    "conceptId" TEXT,
    "assigneeId" TEXT,
    "department" TEXT,
    "color" TEXT,
    "metadata" JSONB,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "content_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "social_posts" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "platform" "SocialPlatform" NOT NULL,
    "caption" TEXT NOT NULL,
    "mediaUrls" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "status" "SocialPostStatus" NOT NULL DEFAULT 'draft',
    "platformPostId" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "social_posts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_conversations" (
    "id" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "subject" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "supplier_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_messages" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "fromStaff" BOOLEAN NOT NULL,
    "senderId" TEXT,
    "body" TEXT NOT NULL,
    "mediaUrl" TEXT,
    "seenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "channel" TEXT NOT NULL DEFAULT 'web_portal',
    "externalMessageId" TEXT,
    "inboundFromAddress" TEXT,

    CONSTRAINT "supplier_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_portal_tokens" (
    "id" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "label" TEXT,
    "expiresAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_portal_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "modifier_templates" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isRequired" BOOLEAN NOT NULL DEFAULT false,
    "minSelect" INTEGER NOT NULL DEFAULT 0,
    "maxSelect" INTEGER NOT NULL DEFAULT 1,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "modifier_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "modifier_template_options" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "priceDeltaCents" INTEGER NOT NULL DEFAULT 0,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isAvailable" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "modifier_template_options_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_zones" (
    "id" TEXT NOT NULL,
    "conceptId" TEXT,
    "name" TEXT NOT NULL,
    "radiusKmMin" DOUBLE PRECISION,
    "radiusKmMax" DOUBLE PRECISION,
    "polygon" JSONB,
    "feeCents" INTEGER NOT NULL DEFAULT 0,
    "freeAboveCents" INTEGER,
    "minOrderCents" INTEGER NOT NULL DEFAULT 0,
    "estimatedMinutes" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "delivery_zones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_templates" (
    "id" TEXT NOT NULL,
    "conceptId" TEXT,
    "channel" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "variables" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "language" TEXT NOT NULL DEFAULT 'en',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_accounts" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "bankName" TEXT,
    "accountTitle" TEXT,
    "accountNumber" TEXT,
    "iban" TEXT,
    "branchCode" TEXT,
    "swiftCode" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'PKR',
    "openingBalanceCents" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "bank_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kds_devices" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "name" TEXT NOT NULL,
    "stationId" TEXT,
    "conceptId" TEXT,
    "deviceFingerprint" TEXT,
    "lastSeenAt" TIMESTAMP(3),
    "ipAddress" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "kds_devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_subscriptions" (
    "id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "events" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "secret" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastSentAt" TIMESTAMP(3),
    "lastStatus" TEXT,
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "webhook_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_deliveries" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "requestBody" TEXT NOT NULL,
    "responseCode" INTEGER,
    "responseBody" TEXT,
    "status" TEXT NOT NULL,
    "durationMs" INTEGER,
    "attemptNumber" INTEGER NOT NULL DEFAULT 1,
    "attemptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "custom_field_definitions" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "options" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "helpText" TEXT,
    "isRequired" BOOLEAN NOT NULL DEFAULT false,
    "showInList" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "custom_field_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "custom_field_values" (
    "id" TEXT NOT NULL,
    "fieldId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "custom_field_values_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scheduled_reports" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "reportType" TEXT NOT NULL,
    "cron" TEXT NOT NULL,
    "recipients" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "conceptId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastRunAt" TIMESTAMP(3),
    "lastStatus" TEXT,
    "notes" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "scheduled_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refund_policies" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'global',
    "scopeId" TEXT,
    "cashierVoidLimitCents" INTEGER NOT NULL DEFAULT 0,
    "cashierCompLimitCents" INTEGER NOT NULL DEFAULT 50000,
    "cashierRefundLimitCents" INTEGER NOT NULL DEFAULT 0,
    "managerVoidLimitCents" INTEGER NOT NULL DEFAULT 500000,
    "managerCompLimitCents" INTEGER NOT NULL DEFAULT 500000,
    "managerRefundLimitCents" INTEGER NOT NULL DEFAULT 500000,
    "requireReason" BOOLEAN NOT NULL DEFAULT true,
    "requirePhotoEvidence" BOOLEAN NOT NULL DEFAULT false,
    "notifyOwnerAboveCents" INTEGER,
    "approverEmail" TEXT,
    "notes" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "refund_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reservation_policies" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'global',
    "scopeId" TEXT,
    "depositRequiredAboveParty" INTEGER,
    "depositCents" INTEGER NOT NULL DEFAULT 0,
    "noShowGraceMinutes" INTEGER NOT NULL DEFAULT 15,
    "cancellationWindowHours" INTEGER NOT NULL DEFAULT 24,
    "maxAdvanceDays" INTEGER NOT NULL DEFAULT 60,
    "minAdvanceHours" INTEGER NOT NULL DEFAULT 2,
    "maxPartySize" INTEGER NOT NULL DEFAULT 20,
    "walkInsAllowed" BOOLEAN NOT NULL DEFAULT true,
    "remindersEnabled" BOOLEAN NOT NULL DEFAULT true,
    "reminderHoursBefore" INTEGER NOT NULL DEFAULT 24,
    "slotIntervalMin" INTEGER NOT NULL DEFAULT 30,
    "defaultDurationMin" INTEGER NOT NULL DEFAULT 90,
    "dayparts" JSONB NOT NULL DEFAULT '[{"label":"Lunch","startHour":0,"endHour":12},{"label":"Afternoon","startHour":12,"endHour":16},{"label":"Dinner","startHour":16,"endHour":22},{"label":"Late night","startHour":22,"endHour":24}]',
    "notes" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "reservation_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receipt_configs" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'global',
    "scopeId" TEXT,
    "paperWidthMm" INTEGER NOT NULL DEFAULT 80,
    "showLogo" BOOLEAN NOT NULL DEFAULT true,
    "logoUrl" TEXT,
    "headerText" TEXT,
    "footerText" TEXT,
    "legalDisclaimer" TEXT,
    "showTaxBreakdown" BOOLEAN NOT NULL DEFAULT true,
    "showFbrInvoice" BOOLEAN NOT NULL DEFAULT true,
    "printerIp" TEXT,
    "printerPort" INTEGER NOT NULL DEFAULT 9100,
    "autoPrintOnOrder" BOOLEAN NOT NULL DEFAULT false,
    "autoPrintOnPay" BOOLEAN NOT NULL DEFAULT true,
    "drawerKickEnabled" BOOLEAN NOT NULL DEFAULT true,
    "cashVarianceLimitCents" INTEGER NOT NULL DEFAULT 20000,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "receipt_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "operations_configs" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'global',
    "scopeId" TEXT,
    "serviceChargePct" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "serviceChargeAppliesToChannels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "tipPoolEnabled" BOOLEAN NOT NULL DEFAULT false,
    "tipPoolDistribution" TEXT NOT NULL DEFAULT 'equal',
    "tipPoolRoleWeights" JSONB,
    "invoiceSequenceReset" TEXT NOT NULL DEFAULT 'yearly',
    "invoiceCreditNotePrefix" TEXT,
    "withholdingTaxEnabled" BOOLEAN NOT NULL DEFAULT false,
    "withholdingTaxPct" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "withholdingTaxRecoverable" BOOLEAN NOT NULL DEFAULT true,
    "secondaryColors" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "fontHeading" TEXT,
    "fontBody" TEXT,
    "brandVoiceNotes" TEXT,
    "socialInstagramHandle" TEXT,
    "socialTiktokHandle" TEXT,
    "socialFacebookUrl" TEXT,
    "cashierDiscountPctCap" DOUBLE PRECISION NOT NULL DEFAULT 0.10,
    "managerDiscountPctCap" DOUBLE PRECISION NOT NULL DEFAULT 0.50,
    "cashierPriceOverrideCap" INTEGER NOT NULL DEFAULT 0,
    "photoRequiredAboveCents" INTEGER NOT NULL DEFAULT 50000,
    "geofenceRadiusMetres" INTEGER NOT NULL DEFAULT 150,
    "geofenceEnforced" BOOLEAN NOT NULL DEFAULT false,
    "selfieRequiredAtClockIn" BOOLEAN NOT NULL DEFAULT false,
    "pii_export_row_threshold" INTEGER NOT NULL DEFAULT 100,
    "shrinkage_trend_weeks" INTEGER NOT NULL DEFAULT 4,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "operations_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "components" (
    "id" TEXT NOT NULL,
    "baseIngredientId" TEXT,
    "name" TEXT NOT NULL,
    "type" "ComponentType" NOT NULL,
    "description" TEXT,
    "preparation" TEXT,
    "seasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "yieldGrams" DOUBLE PRECISION,
    "shelfLifeHours" INTEGER,
    "laborMinutes" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "components_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "component_par_levels" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "componentId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "targetCount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "actualCount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "unit" TEXT,
    "notes" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "component_par_levels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "component_brand_uses" (
    "componentId" TEXT NOT NULL,
    "conceptId" TEXT NOT NULL,
    "usageNote" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "component_brand_uses_pkey" PRIMARY KEY ("componentId","conceptId")
);

-- CreateTable
CREATE TABLE "capital_ledger_entries" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "conceptId" TEXT,
    "projectId" TEXT,
    "date" TIMESTAMP(3) NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "paidTo" TEXT,
    "invoiceUrl" TEXT,
    "category" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "capital_ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "capex_projects" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "conceptId" TEXT,
    "locationId" TEXT,
    "name" TEXT NOT NULL,
    "projectType" TEXT NOT NULL DEFAULT 'kitchen_buildout',
    "phase" TEXT NOT NULL DEFAULT 'planning',
    "budgetEnvelopeCents" INTEGER NOT NULL DEFAULT 0,
    "contingencyPct" DOUBLE PRECISION NOT NULL DEFAULT 0.10,
    "totalAskCents" INTEGER NOT NULL DEFAULT 0,
    "consultantFeesCents" INTEGER NOT NULL DEFAULT 0,
    "taxCents" INTEGER NOT NULL DEFAULT 0,
    "targetOpeningDate" TIMESTAMP(3),
    "actualOpeningDate" TIMESTAMP(3),
    "ownerId" TEXT,
    "address" TEXT,
    "floorAreaSqft" INTEGER,
    "scopeConfig" JSONB,
    "isJointVenture" BOOLEAN NOT NULL DEFAULT false,
    "jvPartners" JSONB,
    "status" TEXT NOT NULL DEFAULT 'planning',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "capex_projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "capex_lines" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "category" TEXT,
    "item" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unitCostCents" INTEGER NOT NULL,
    "vendor" TEXT,
    "vendorContact" TEXT,
    "quotedCents" INTEGER,
    "negotiatedCents" INTEGER,
    "paidCents" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'not_quoted',
    "priority" TEXT NOT NULL DEFAULT 'must_have',
    "leadTimeDays" INTEGER,
    "expectedDeliveryDate" TIMESTAMP(3),
    "actualDeliveryDate" TIMESTAMP(3),
    "installedDate" TIMESTAMP(3),
    "documentUrls" JSONB,
    "photoUrls" JSONB,
    "warrantyMonths" INTEGER,
    "assignedToId" TEXT,
    "notes" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "capex_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "capex_quotes" (
    "id" TEXT NOT NULL,
    "lineId" TEXT NOT NULL,
    "vendor" TEXT NOT NULL,
    "contactName" TEXT,
    "contactPhone" TEXT,
    "totalCents" INTEGER NOT NULL,
    "leadTimeDays" INTEGER,
    "validUntil" TIMESTAMP(3),
    "fileUrl" TEXT,
    "notes" TEXT,
    "isWinner" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "capex_quotes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "opex_categories" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "conceptId" TEXT,
    "name" TEXT NOT NULL,
    "emoji" TEXT,
    "budgetMonthlyCents" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "opex_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "opex_lines" (
    "id" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "conceptId" TEXT,
    "projectId" TEXT,
    "name" TEXT NOT NULL,
    "vendor" TEXT,
    "vendorContact" TEXT,
    "amountCents" INTEGER NOT NULL,
    "cadence" TEXT NOT NULL DEFAULT 'monthly',
    "nextDueDate" TIMESTAMP(3),
    "paymentMethod" TEXT,
    "bankAccountId" TEXT,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "opex_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "opex_payments" (
    "id" TEXT NOT NULL,
    "lineId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "expectedCents" INTEGER NOT NULL,
    "actualCents" INTEGER,
    "paidAt" TIMESTAMP(3),
    "paymentRef" TEXT,
    "receiptUrl" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "opex_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "capex_payments" (
    "id" TEXT NOT NULL,
    "lineId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "dueDate" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "paidAmountCents" INTEGER,
    "paymentRef" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "capex_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pro_formas" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "conceptId" TEXT,
    "name" TEXT NOT NULL,
    "scenario" TEXT NOT NULL DEFAULT 'base',
    "totalAskCents" INTEGER NOT NULL DEFAULT 0,
    "capexCents" INTEGER NOT NULL DEFAULT 0,
    "workingCapitalCents" INTEGER NOT NULL DEFAULT 0,
    "brokerFeeCents" INTEGER NOT NULL DEFAULT 0,
    "rentAdvanceSecurityCents" INTEGER NOT NULL DEFAULT 0,
    "monthlyFixedCostsCents" INTEGER NOT NULL DEFAULT 0,
    "variableCostPct" DOUBLE PRECISION NOT NULL DEFAULT 0.40,
    "tradingDaysPerMonth" INTEGER NOT NULL DEFAULT 26,
    "notes" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "pro_formas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pro_forma_channels" (
    "id" TEXT NOT NULL,
    "proFormaId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "checkAvgCents" INTEGER NOT NULL,
    "ordersTue" INTEGER NOT NULL DEFAULT 0,
    "ordersWed" INTEGER NOT NULL DEFAULT 0,
    "ordersThu" INTEGER NOT NULL DEFAULT 0,
    "ordersFri" INTEGER NOT NULL DEFAULT 0,
    "ordersSat" INTEGER NOT NULL DEFAULT 0,
    "ordersSun" INTEGER NOT NULL DEFAULT 0,
    "ordersMon" INTEGER NOT NULL DEFAULT 0,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "pro_forma_channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pro_forma_fixed_costs" (
    "id" TEXT NOT NULL,
    "proFormaId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "monthlyCents" INTEGER NOT NULL,
    "notes" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "pro_forma_fixed_costs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pro_forma_months" (
    "id" TEXT NOT NULL,
    "proFormaId" TEXT NOT NULL,
    "monthIndex" INTEGER NOT NULL,
    "rampPct" DOUBLE PRECISION NOT NULL,
    "channelOverrides" JSONB,
    "notes" TEXT,

    CONSTRAINT "pro_forma_months_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projections" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "name" TEXT NOT NULL DEFAULT 'Default scenario',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "rampCurve" DOUBLE PRECISION[] DEFAULT ARRAY[0.30, 0.45, 0.60, 0.75, 0.90, 1.00, 1.00, 1.00, 1.00, 1.00, 1.00, 1.00]::DOUBLE PRECISION[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "projections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projection_brand_inputs" (
    "id" TEXT NOT NULL,
    "projectionId" TEXT NOT NULL,
    "conceptId" TEXT NOT NULL,
    "launchMonth" INTEGER NOT NULL DEFAULT 1,
    "checkAverageCents" INTEGER NOT NULL DEFAULT 0,
    "tradingDaysPerMonth" INTEGER NOT NULL DEFAULT 26,
    "foodCostPct" DOUBLE PRECISION NOT NULL DEFAULT 32,
    "packagingCostPct" DOUBLE PRECISION NOT NULL DEFAULT 8,
    "dailyCoversAtSS" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "projection_brand_inputs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "domains" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "conceptId" TEXT,
    "hostname" TEXT NOT NULL,
    "purpose" TEXT NOT NULL DEFAULT 'order',
    "status" "DomainStatus" NOT NULL DEFAULT 'pending',
    "verificationToken" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3),
    "sslIssuedAt" TIMESTAMP(3),
    "lastCheckedAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "domains_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenants" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "industry" TEXT,
    "countryCode" TEXT NOT NULL DEFAULT 'PK',
    "currency" TEXT NOT NULL DEFAULT 'PKR',
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Karachi',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isJointVenture" BOOLEAN NOT NULL DEFAULT false,
    "jvPartners" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_members" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'owner',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_gateway_configs" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "conceptId" TEXT,
    "isEnabled" BOOLEAN NOT NULL DEFAULT false,
    "isLive" BOOLEAN NOT NULL DEFAULT false,
    "merchantId" TEXT,
    "callbackUrl" TEXT,
    "successUrl" TEXT,
    "failureUrl" TEXT,
    "notes" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "payment_gateway_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "locations" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "city" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "phone" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_transfers" (
    "id" TEXT NOT NULL,
    "inventoryItemId" TEXT NOT NULL,
    "fromLocationId" TEXT NOT NULL,
    "toLocationId" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "unit" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'requested',
    "reason" TEXT,
    "notes" TEXT,
    "requestedById" TEXT NOT NULL,
    "approvedById" TEXT,
    "shippedById" TEXT,
    "receivedById" TEXT,
    "cancelledById" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" TIMESTAMP(3),
    "shippedAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "receivedQuantity" DOUBLE PRECISION,

    CONSTRAINT "stock_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "concept_locations" (
    "conceptId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "concept_locations_pkey" PRIMARY KEY ("conceptId","locationId")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "id" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "permission" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_assets" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'general',
    "uploadedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "media_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goods_receipts" (
    "id" TEXT NOT NULL,
    "poId" TEXT,
    "supplierId" TEXT NOT NULL,
    "receivedById" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "photoUrl" TEXT,
    "notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "varianceFlag" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "goods_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goods_receipt_lines" (
    "id" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "inventoryItemId" TEXT,
    "description" TEXT NOT NULL,
    "poQty" DOUBLE PRECISION,
    "receivedQty" DOUBLE PRECISION NOT NULL,
    "poUnitCostCents" INTEGER,
    "unit" TEXT NOT NULL DEFAULT 'kg',
    "variancePct" DOUBLE PRECISION,
    "notes" TEXT,

    CONSTRAINT "goods_receipt_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prep_batches" (
    "id" TEXT NOT NULL,
    "recipeId" TEXT,
    "itemName" TEXT NOT NULL,
    "inputs" JSONB NOT NULL,
    "expectedYieldQty" DOUBLE PRECISION,
    "actualYieldQty" DOUBLE PRECISION NOT NULL,
    "unit" TEXT NOT NULL DEFAULT 'g',
    "yieldVariancePct" DOUBLE PRECISION,
    "staffId" TEXT NOT NULL,
    "photoUrl" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prep_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "physical_counts" (
    "id" TEXT NOT NULL,
    "countedById" TEXT NOT NULL,
    "countedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "notes" TEXT,

    CONSTRAINT "physical_counts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "physical_count_lines" (
    "id" TEXT NOT NULL,
    "countId" TEXT NOT NULL,
    "inventoryItemId" TEXT NOT NULL,
    "systemQty" DOUBLE PRECISION NOT NULL,
    "physicalQty" DOUBLE PRECISION NOT NULL,
    "variancePct" DOUBLE PRECISION,
    "reason" TEXT,

    CONSTRAINT "physical_count_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exception_flags" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "severity" "ExceptionSeverity" NOT NULL DEFAULT 'medium',
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "metadata" JSONB,
    "conceptId" TEXT,
    "actorId" TEXT,
    "amountCents" INTEGER,
    "status" "ExceptionStatus" NOT NULL DEFAULT 'open',
    "acknowledgedById" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolution" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "exception_flags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "petty_cash_boxes" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "conceptId" TEXT,
    "custodianId" TEXT NOT NULL,
    "floatCents" INTEGER NOT NULL DEFAULT 0,
    "topUpLimitCents" INTEGER NOT NULL DEFAULT 2000000,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "petty_cash_boxes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "petty_cash_movements" (
    "id" TEXT NOT NULL,
    "boxId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "category" TEXT,
    "reason" TEXT NOT NULL,
    "receiptUrl" TEXT,
    "vendorName" TEXT,
    "approvedById" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "petty_cash_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deposit_drops" (
    "id" TEXT NOT NULL,
    "shiftId" TEXT,
    "conceptId" TEXT,
    "bankAccountId" TEXT,
    "amountCents" INTEGER NOT NULL,
    "expectedCents" INTEGER NOT NULL,
    "varianceCents" INTEGER NOT NULL,
    "bagSerial" TEXT,
    "receiptUrl" TEXT,
    "droppedById" TEXT NOT NULL,
    "witnessedById" TEXT,
    "droppedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,

    CONSTRAINT "deposit_drops_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_meals" (
    "id" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "approvedById" TEXT NOT NULL,
    "shiftId" TEXT,
    "conceptId" TEXT,
    "description" TEXT NOT NULL,
    "estimatedCostCents" INTEGER NOT NULL DEFAULT 0,
    "reason" TEXT NOT NULL DEFAULT 'shift_meal',
    "consumedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_meals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kitchen_staff" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "cnic" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "kitchenRole" "KitchenStaffRole" NOT NULL,
    "skillLevel" "SkillLevel" NOT NULL,
    "employmentType" "EmploymentType" NOT NULL,
    "dateJoined" TIMESTAMP(3) NOT NULL,
    "dateLeft" TIMESTAMP(3),
    "monthlySalaryCash" INTEGER NOT NULL,
    "mealsProvided" BOOLEAN NOT NULL DEFAULT false,
    "accommodationProvided" BOOLEAN NOT NULL DEFAULT false,
    "accommodationValue" INTEGER NOT NULL DEFAULT 0,
    "eobiRegistered" BOOLEAN NOT NULL DEFAULT false,
    "sessiRegistered" BOOLEAN NOT NULL DEFAULT false,
    "bankAccount" TEXT,
    "emergencyContact" TEXT NOT NULL,
    "status" "KitchenStaffStatus" NOT NULL DEFAULT 'active',
    "stationIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "kitchen_staff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kitchen_shifts" (
    "id" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "scheduledStart" TEXT NOT NULL,
    "scheduledEnd" TEXT NOT NULL,
    "actualStart" TEXT,
    "actualEnd" TEXT,
    "breakMinutes" INTEGER NOT NULL DEFAULT 60,
    "isWeeklyOff" BOOLEAN NOT NULL DEFAULT false,
    "isFestivalHoliday" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "kitchen_shifts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wage_settings" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "minWageUnskilled" INTEGER NOT NULL DEFAULT 40000,
    "minWageSemiSkilled" INTEGER NOT NULL DEFAULT 41280,
    "minWageSkilled" INTEGER NOT NULL DEFAULT 48910,
    "minWageHighlySkilled" INTEGER NOT NULL DEFAULT 50868,
    "workingDaysPerMonth" INTEGER NOT NULL DEFAULT 26,
    "paidHoursPerDay" INTEGER NOT NULL DEFAULT 8,
    "otMultiplierRegular" DOUBLE PRECISION NOT NULL DEFAULT 2.0,
    "otMultiplierFestival" DOUBLE PRECISION NOT NULL DEFAULT 3.0,
    "maxOtHoursPerWeek" INTEGER NOT NULL DEFAULT 12,
    "maxOtHoursPerYear" INTEGER NOT NULL DEFAULT 624,
    "eobiEmployerPct" DOUBLE PRECISION NOT NULL DEFAULT 0.01,
    "sessiEmployerPct" DOUBLE PRECISION NOT NULL DEFAULT 0.06,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wage_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kitchen_payroll_runs" (
    "id" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "month" INTEGER NOT NULL,
    "year" INTEGER NOT NULL,
    "baseSalary" INTEGER NOT NULL,
    "regularHoursWorked" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "otHoursRegular" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "otHoursFestival" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "hourlyRate" DOUBLE PRECISION NOT NULL,
    "otPayRegular" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "otPayFestival" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "mealValue" INTEGER NOT NULL DEFAULT 0,
    "accommodationValue" INTEGER NOT NULL DEFAULT 0,
    "grossPay" DOUBLE PRECISION NOT NULL,
    "eobiEmployee" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "eobiEmployer" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "sessiEmployer" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "incomeTaxWithheld" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "netPay" DOUBLE PRECISION NOT NULL,
    "trueCostToCompany" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "kitchen_payroll_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compliance_violations" (
    "id" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,

    CONSTRAINT "compliance_violations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "departments" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "name" TEXT NOT NULL,
    "emoji" TEXT,
    "isHeadOffice" BOOLEAN NOT NULL DEFAULT false,
    "order" INTEGER NOT NULL DEFAULT 0,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shift_bands" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "name" TEXT NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shift_bands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_contributions" (
    "id" TEXT NOT NULL,
    "sourceTenantId" TEXT NOT NULL,
    "destinationTenantId" TEXT NOT NULL,
    "category" "ContributionCategory" NOT NULL DEFAULT 'head_office',
    "monthlyCents" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "internalSplit" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_contributions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "positions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "conceptId" TEXT,
    "departmentId" TEXT,
    "shiftBandId" TEXT,
    "title" TEXT NOT NULL,
    "monthlySalaryCents" INTEGER NOT NULL,
    "tenantCostShareCents" INTEGER NOT NULL,
    "costShareNote" TEXT,
    "headcount" INTEGER NOT NULL DEFAULT 1,
    "filledByUserId" TEXT,
    "status" "PositionStatus" NOT NULL DEFAULT 'open',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "positions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "concepts_slug_key" ON "concepts"("slug");

-- CreateIndex
CREATE INDEX "concepts_tenantId_idx" ON "concepts"("tenantId");

-- CreateIndex
CREATE INDEX "tables_conceptId_floorId_idx" ON "tables"("conceptId", "floorId");

-- CreateIndex
CREATE INDEX "floors_conceptId_displayOrder_idx" ON "floors"("conceptId", "displayOrder");

-- CreateIndex
CREATE UNIQUE INDEX "reservations_confirmToken_key" ON "reservations"("confirmToken");

-- CreateIndex
CREATE UNIQUE INDEX "reservations_promotionToken_key" ON "reservations"("promotionToken");

-- CreateIndex
CREATE INDEX "reservations_conceptId_startTime_idx" ON "reservations"("conceptId", "startTime");

-- CreateIndex
CREATE INDEX "reservations_tableId_startTime_idx" ON "reservations"("tableId", "startTime");

-- CreateIndex
CREATE INDEX "reservations_promotionExpiresAt_idx" ON "reservations"("promotionExpiresAt");

-- CreateIndex
CREATE INDEX "reservations_status_startTime_idx" ON "reservations"("status", "startTime");

-- CreateIndex
CREATE INDEX "reservations_reminder24hSentAt_idx" ON "reservations"("reminder24hSentAt");

-- CreateIndex
CREATE INDEX "concept_blockouts_conceptId_startTime_idx" ON "concept_blockouts"("conceptId", "startTime");

-- CreateIndex
CREATE UNIQUE INDEX "service_hours_conceptId_dayOfWeek_openMin_key" ON "service_hours"("conceptId", "dayOfWeek", "openMin");

-- CreateIndex
CREATE UNIQUE INDEX "gift_cards_code_key" ON "gift_cards"("code");

-- CreateIndex
CREATE INDEX "gift_cards_status_idx" ON "gift_cards"("status");

-- CreateIndex
CREATE INDEX "gift_cards_buyerEmail_idx" ON "gift_cards"("buyerEmail");

-- CreateIndex
CREATE INDEX "gift_card_redemptions_giftCardId_redeemedAt_idx" ON "gift_card_redemptions"("giftCardId", "redeemedAt" DESC);

-- CreateIndex
CREATE INDEX "gift_card_redemptions_orderId_idx" ON "gift_card_redemptions"("orderId");

-- CreateIndex
CREATE INDEX "guest_tags_customerId_idx" ON "guest_tags"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "shifts_locationId_openedAt_idx" ON "shifts"("locationId", "openedAt" DESC);

-- CreateIndex
CREATE INDEX "cash_movements_shiftId_recordedAt_idx" ON "cash_movements"("shiftId", "recordedAt");

-- CreateIndex
CREATE INDEX "expo_push_tokens_userId_idx" ON "expo_push_tokens"("userId");

-- CreateIndex
CREATE INDEX "expo_push_tokens_device_locationId_idx" ON "expo_push_tokens"("device", "locationId");

-- CreateIndex
CREATE UNIQUE INDEX "expo_push_tokens_userId_token_key" ON "expo_push_tokens"("userId", "token");

-- CreateIndex
CREATE INDEX "clock_logs_userId_recordedAt_idx" ON "clock_logs"("userId", "recordedAt");

-- CreateIndex
CREATE INDEX "payroll_runs_periodStart_idx" ON "payroll_runs"("periodStart" DESC);

-- CreateIndex
CREATE INDEX "payroll_run_lines_payrollRunId_idx" ON "payroll_run_lines"("payrollRunId");

-- CreateIndex
CREATE INDEX "payroll_run_lines_userId_idx" ON "payroll_run_lines"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "customers_email_key" ON "customers"("email");

-- CreateIndex
CREATE UNIQUE INDEX "customers_phone_key" ON "customers"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "customers_referralCode_key" ON "customers"("referralCode");

-- CreateIndex
CREATE INDEX "customer_strikes_customerId_recordedAt_idx" ON "customer_strikes"("customerId", "recordedAt");

-- CreateIndex
CREATE INDEX "customer_strikes_kind_recordedAt_idx" ON "customer_strikes"("kind", "recordedAt");

-- CreateIndex
CREATE INDEX "customer_bans_email_idx" ON "customer_bans"("email");

-- CreateIndex
CREATE INDEX "customer_bans_phone_idx" ON "customer_bans"("phone");

-- CreateIndex
CREATE INDEX "customer_bans_bannedAt_idx" ON "customer_bans"("bannedAt");

-- CreateIndex
CREATE INDEX "customer_bans_liftedAt_idx" ON "customer_bans"("liftedAt");

-- CreateIndex
CREATE INDEX "customer_conversations_customerId_updatedAt_idx" ON "customer_conversations"("customerId", "updatedAt");

-- CreateIndex
CREATE INDEX "customer_conversations_staffId_idx" ON "customer_conversations"("staffId");

-- CreateIndex
CREATE INDEX "customer_conversations_source_sourceRefId_idx" ON "customer_conversations"("source", "sourceRefId");

-- CreateIndex
CREATE UNIQUE INDEX "customer_messages_externalMessageId_key" ON "customer_messages"("externalMessageId");

-- CreateIndex
CREATE INDEX "customer_messages_conversationId_createdAt_idx" ON "customer_messages"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "customer_addresses_customerId_idx" ON "customer_addresses"("customerId");

-- CreateIndex
CREATE INDEX "trigger_logs_customerId_triggerType_createdAt_idx" ON "trigger_logs"("customerId", "triggerType", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "tier_configs_tier_key" ON "tier_configs"("tier");

-- CreateIndex
CREATE INDEX "feedback_entries_conceptId_createdAt_idx" ON "feedback_entries"("conceptId", "createdAt");

-- CreateIndex
CREATE INDEX "feedback_entries_customerId_createdAt_idx" ON "feedback_entries"("customerId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "magic_links_token_key" ON "magic_links"("token");

-- CreateIndex
CREATE INDEX "phone_otps_phone_purpose_createdAt_idx" ON "phone_otps"("phone", "purpose", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "loyalty_accounts_customerId_key" ON "loyalty_accounts"("customerId");

-- CreateIndex
CREATE INDEX "orders_conceptId_placedAt_idx" ON "orders"("conceptId", "placedAt" DESC);

-- CreateIndex
CREATE INDEX "orders_locationId_placedAt_idx" ON "orders"("locationId", "placedAt" DESC);

-- CreateIndex
CREATE INDEX "orders_status_placedAt_idx" ON "orders"("status", "placedAt" DESC);

-- CreateIndex
CREATE INDEX "orders_customerId_idx" ON "orders"("customerId");

-- CreateIndex
CREATE INDEX "orders_shiftId_idx" ON "orders"("shiftId");

-- CreateIndex
CREATE INDEX "orders_placedAt_idx" ON "orders"("placedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "orders_source_externalId_key" ON "orders"("source", "externalId");

-- CreateIndex
CREATE INDEX "order_items_orderId_idx" ON "order_items"("orderId");

-- CreateIndex
CREATE INDEX "order_items_stationId_status_idx" ON "order_items"("stationId", "status");

-- CreateIndex
CREATE INDEX "payments_orderId_idx" ON "payments"("orderId");

-- CreateIndex
CREATE INDEX "payments_shiftId_status_idx" ON "payments"("shiftId", "status");

-- CreateIndex
CREATE INDEX "payments_gatewayRef_idx" ON "payments"("gatewayRef");

-- CreateIndex
CREATE INDEX "tip_pools_periodStart_idx" ON "tip_pools"("periodStart" DESC);

-- CreateIndex
CREATE INDEX "tip_pool_members_userId_idx" ON "tip_pool_members"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "tip_pool_members_poolId_userId_key" ON "tip_pool_members"("poolId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "group_orders_shareCode_key" ON "group_orders"("shareCode");

-- CreateIndex
CREATE INDEX "group_orders_shareCode_idx" ON "group_orders"("shareCode");

-- CreateIndex
CREATE UNIQUE INDEX "group_order_members_groupOrderId_displayName_key" ON "group_order_members"("groupOrderId", "displayName");

-- CreateIndex
CREATE INDEX "group_order_items_groupOrderId_idx" ON "group_order_items"("groupOrderId");

-- CreateIndex
CREATE INDEX "inventory_items_tenantId_idx" ON "inventory_items"("tenantId");

-- CreateIndex
CREATE INDEX "waste_logs_inventoryItemId_recordedAt_idx" ON "waste_logs"("inventoryItemId", "recordedAt" DESC);

-- CreateIndex
CREATE INDEX "waste_logs_recordedAt_idx" ON "waste_logs"("recordedAt" DESC);

-- CreateIndex
CREATE INDEX "suppliers_tenantId_idx" ON "suppliers"("tenantId");

-- CreateIndex
CREATE INDEX "suppliers_whatsappPhone_idx" ON "suppliers"("whatsappPhone");

-- CreateIndex
CREATE INDEX "suppliers_email_idx" ON "suppliers"("email");

-- CreateIndex
CREATE UNIQUE INDEX "recipes_menuItemId_key" ON "recipes"("menuItemId");

-- CreateIndex
CREATE INDEX "recipes_isActive_idx" ON "recipes"("isActive");

-- CreateIndex
CREATE INDEX "recipe_steps_recipeId_phase_ordinal_idx" ON "recipe_steps"("recipeId", "phase", "ordinal");

-- CreateIndex
CREATE INDEX "order_item_steps_stationId_status_idx" ON "order_item_steps"("stationId", "status");

-- CreateIndex
CREATE INDEX "order_item_steps_orderItemId_idx" ON "order_item_steps"("orderItemId");

-- CreateIndex
CREATE INDEX "purchase_orders_supplierId_status_idx" ON "purchase_orders"("supplierId", "status");

-- CreateIndex
CREATE INDEX "purchase_orders_status_orderDate_idx" ON "purchase_orders"("status", "orderDate" DESC);

-- CreateIndex
CREATE INDEX "purchase_order_lines_purchaseOrderId_idx" ON "purchase_order_lines"("purchaseOrderId");

-- CreateIndex
CREATE INDEX "purchase_order_lines_inventoryItemId_idx" ON "purchase_order_lines"("inventoryItemId");

-- CreateIndex
CREATE INDEX "po_activity_log_purchaseOrderId_createdAt_idx" ON "po_activity_log"("purchaseOrderId", "createdAt");

-- CreateIndex
CREATE INDEX "receiving_discrepancies_poLineId_idx" ON "receiving_discrepancies"("poLineId");

-- CreateIndex
CREATE INDEX "item_price_history_inventoryItemId_recordedAt_idx" ON "item_price_history"("inventoryItemId", "recordedAt" DESC);

-- CreateIndex
CREATE INDEX "item_price_history_supplierId_recordedAt_idx" ON "item_price_history"("supplierId", "recordedAt" DESC);

-- CreateIndex
CREATE INDEX "supplier_bills_supplierId_status_idx" ON "supplier_bills"("supplierId", "status");

-- CreateIndex
CREATE INDEX "supplier_bills_dueDate_status_idx" ON "supplier_bills"("dueDate", "status");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_bills_supplierId_billNumber_key" ON "supplier_bills"("supplierId", "billNumber");

-- CreateIndex
CREATE INDEX "supplier_bill_lines_billId_idx" ON "supplier_bill_lines"("billId");

-- CreateIndex
CREATE INDEX "supplier_payments_supplierId_paymentDate_idx" ON "supplier_payments"("supplierId", "paymentDate" DESC);

-- CreateIndex
CREATE INDEX "supplier_payment_applications_billId_idx" ON "supplier_payment_applications"("billId");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_payment_applications_paymentId_billId_key" ON "supplier_payment_applications"("paymentId", "billId");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_code_key" ON "accounts"("code");

-- CreateIndex
CREATE INDEX "bank_statement_imports_source_statementDate_idx" ON "bank_statement_imports"("source", "statementDate" DESC);

-- CreateIndex
CREATE INDEX "bank_statement_lines_importId_matchStatus_idx" ON "bank_statement_lines"("importId", "matchStatus");

-- CreateIndex
CREATE INDEX "bank_statement_lines_postedDate_idx" ON "bank_statement_lines"("postedDate" DESC);

-- CreateIndex
CREATE INDEX "foodpanda_settlements_settlementDate_idx" ON "foodpanda_settlements"("settlementDate" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "cost_allocation_rules_sourceAccountCode_key" ON "cost_allocation_rules"("sourceAccountCode");

-- CreateIndex
CREATE UNIQUE INDEX "allocation_rule_weights_ruleId_conceptId_key" ON "allocation_rule_weights"("ruleId", "conceptId");

-- CreateIndex
CREATE INDEX "cost_allocation_runs_ruleId_periodStart_idx" ON "cost_allocation_runs"("ruleId", "periodStart" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "tax_invoices_invoiceNumber_key" ON "tax_invoices"("invoiceNumber");

-- CreateIndex
CREATE INDEX "tax_invoices_conceptId_issuedAt_idx" ON "tax_invoices"("conceptId", "issuedAt" DESC);

-- CreateIndex
CREATE INDEX "tax_invoices_orderId_idx" ON "tax_invoices"("orderId");

-- CreateIndex
CREATE INDEX "tax_invoice_lines_invoiceId_idx" ON "tax_invoice_lines"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "site_layouts_slug_key" ON "site_layouts"("slug");

-- CreateIndex
CREATE INDEX "site_layouts_slug_idx" ON "site_layouts"("slug");

-- CreateIndex
CREATE INDEX "audit_logs_action_createdAt_idx" ON "audit_logs"("action", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_entity_entityId_idx" ON "audit_logs"("entity", "entityId");

-- CreateIndex
CREATE INDEX "audit_logs_userId_createdAt_idx" ON "audit_logs"("userId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "financial_entries_orderId_key" ON "financial_entries"("orderId");

-- CreateIndex
CREATE INDEX "financial_entries_conceptId_entryDate_idx" ON "financial_entries"("conceptId", "entryDate" DESC);

-- CreateIndex
CREATE INDEX "financial_entries_locationId_entryDate_idx" ON "financial_entries"("locationId", "entryDate" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "riders_phone_key" ON "riders"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "rider_ratings_orderId_key" ON "rider_ratings"("orderId");

-- CreateIndex
CREATE INDEX "rider_ratings_riderId_createdAt_idx" ON "rider_ratings"("riderId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "rider_locations_riderId_recordedAt_idx" ON "rider_locations"("riderId", "recordedAt" DESC);

-- CreateIndex
CREATE INDEX "rider_locations_orderId_recordedAt_idx" ON "rider_locations"("orderId", "recordedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "order_reviews_orderId_key" ON "order_reviews"("orderId");

-- CreateIndex
CREATE INDEX "order_reviews_conceptId_createdAt_idx" ON "order_reviews"("conceptId", "createdAt");

-- CreateIndex
CREATE INDEX "order_reviews_conceptId_rating_idx" ON "order_reviews"("conceptId", "rating");

-- CreateIndex
CREATE INDEX "wallet_transactions_customerId_createdAt_idx" ON "wallet_transactions"("customerId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "promo_codes_code_key" ON "promo_codes"("code");

-- CreateIndex
CREATE UNIQUE INDEX "abandoned_carts_cartId_key" ON "abandoned_carts"("cartId");

-- CreateIndex
CREATE INDEX "abandoned_carts_conceptId_abandonedAt_idx" ON "abandoned_carts"("conceptId", "abandonedAt");

-- CreateIndex
CREATE INDEX "scheduled_shifts_conceptId_date_idx" ON "scheduled_shifts"("conceptId", "date");

-- CreateIndex
CREATE INDEX "analytics_events_customerId_createdAt_idx" ON "analytics_events"("customerId", "createdAt");

-- CreateIndex
CREATE INDEX "analytics_events_conceptId_event_createdAt_idx" ON "analytics_events"("conceptId", "event", "createdAt");

-- CreateIndex
CREATE INDEX "analytics_events_event_createdAt_idx" ON "analytics_events"("event", "createdAt");

-- CreateIndex
CREATE INDEX "analytics_events_sessionId_idx" ON "analytics_events"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "customer_segments_slug_key" ON "customer_segments"("slug");

-- CreateIndex
CREATE INDEX "customer_segment_memberships_segmentId_idx" ON "customer_segment_memberships"("segmentId");

-- CreateIndex
CREATE INDEX "content_events_startDate_idx" ON "content_events"("startDate");

-- CreateIndex
CREATE INDEX "content_events_conceptId_startDate_idx" ON "content_events"("conceptId", "startDate");

-- CreateIndex
CREATE UNIQUE INDEX "social_posts_eventId_key" ON "social_posts"("eventId");

-- CreateIndex
CREATE INDEX "social_posts_scheduledFor_status_idx" ON "social_posts"("scheduledFor", "status");

-- CreateIndex
CREATE INDEX "supplier_conversations_supplierId_idx" ON "supplier_conversations"("supplierId");

-- CreateIndex
CREATE INDEX "supplier_conversations_staffId_idx" ON "supplier_conversations"("staffId");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_messages_externalMessageId_key" ON "supplier_messages"("externalMessageId");

-- CreateIndex
CREATE INDEX "supplier_messages_conversationId_createdAt_idx" ON "supplier_messages"("conversationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_portal_tokens_token_key" ON "supplier_portal_tokens"("token");

-- CreateIndex
CREATE INDEX "supplier_portal_tokens_token_idx" ON "supplier_portal_tokens"("token");

-- CreateIndex
CREATE INDEX "modifier_template_options_templateId_idx" ON "modifier_template_options"("templateId");

-- CreateIndex
CREATE INDEX "delivery_zones_conceptId_idx" ON "delivery_zones"("conceptId");

-- CreateIndex
CREATE INDEX "notification_templates_conceptId_channel_idx" ON "notification_templates"("conceptId", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "notification_templates_conceptId_channel_event_language_key" ON "notification_templates"("conceptId", "channel", "event", "language");

-- CreateIndex
CREATE UNIQUE INDEX "kds_devices_deviceFingerprint_key" ON "kds_devices"("deviceFingerprint");

-- CreateIndex
CREATE INDEX "kds_devices_stationId_idx" ON "kds_devices"("stationId");

-- CreateIndex
CREATE INDEX "kds_devices_tenantId_idx" ON "kds_devices"("tenantId");

-- CreateIndex
CREATE INDEX "webhook_deliveries_subscriptionId_attemptedAt_idx" ON "webhook_deliveries"("subscriptionId", "attemptedAt" DESC);

-- CreateIndex
CREATE INDEX "webhook_deliveries_event_attemptedAt_idx" ON "webhook_deliveries"("event", "attemptedAt" DESC);

-- CreateIndex
CREATE INDEX "custom_field_definitions_scope_idx" ON "custom_field_definitions"("scope");

-- CreateIndex
CREATE UNIQUE INDEX "custom_field_definitions_scope_key_key" ON "custom_field_definitions"("scope", "key");

-- CreateIndex
CREATE INDEX "custom_field_values_entityType_entityId_idx" ON "custom_field_values"("entityType", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX "custom_field_values_fieldId_entityType_entityId_key" ON "custom_field_values"("fieldId", "entityType", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX "refund_policies_scope_scopeId_key" ON "refund_policies"("scope", "scopeId");

-- CreateIndex
CREATE UNIQUE INDEX "reservation_policies_scope_scopeId_key" ON "reservation_policies"("scope", "scopeId");

-- CreateIndex
CREATE UNIQUE INDEX "receipt_configs_scope_scopeId_key" ON "receipt_configs"("scope", "scopeId");

-- CreateIndex
CREATE UNIQUE INDEX "operations_configs_scope_scopeId_key" ON "operations_configs"("scope", "scopeId");

-- CreateIndex
CREATE INDEX "components_baseIngredientId_idx" ON "components"("baseIngredientId");

-- CreateIndex
CREATE INDEX "components_type_idx" ON "components"("type");

-- CreateIndex
CREATE INDEX "components_isActive_idx" ON "components"("isActive");

-- CreateIndex
CREATE INDEX "component_par_levels_tenantId_date_idx" ON "component_par_levels"("tenantId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "component_par_levels_tenantId_componentId_date_key" ON "component_par_levels"("tenantId", "componentId", "date");

-- CreateIndex
CREATE INDEX "component_brand_uses_conceptId_idx" ON "component_brand_uses"("conceptId");

-- CreateIndex
CREATE INDEX "capital_ledger_entries_tenantId_date_idx" ON "capital_ledger_entries"("tenantId", "date" DESC);

-- CreateIndex
CREATE INDEX "capital_ledger_entries_conceptId_date_idx" ON "capital_ledger_entries"("conceptId", "date" DESC);

-- CreateIndex
CREATE INDEX "capital_ledger_entries_projectId_idx" ON "capital_ledger_entries"("projectId");

-- CreateIndex
CREATE INDEX "capex_projects_tenantId_idx" ON "capex_projects"("tenantId");

-- CreateIndex
CREATE INDEX "capex_projects_conceptId_idx" ON "capex_projects"("conceptId");

-- CreateIndex
CREATE INDEX "capex_projects_locationId_idx" ON "capex_projects"("locationId");

-- CreateIndex
CREATE INDEX "capex_lines_projectId_idx" ON "capex_lines"("projectId");

-- CreateIndex
CREATE INDEX "capex_lines_status_idx" ON "capex_lines"("status");

-- CreateIndex
CREATE INDEX "capex_quotes_lineId_idx" ON "capex_quotes"("lineId");

-- CreateIndex
CREATE INDEX "opex_categories_tenantId_idx" ON "opex_categories"("tenantId");

-- CreateIndex
CREATE INDEX "opex_categories_conceptId_idx" ON "opex_categories"("conceptId");

-- CreateIndex
CREATE INDEX "opex_lines_categoryId_idx" ON "opex_lines"("categoryId");

-- CreateIndex
CREATE INDEX "opex_lines_projectId_idx" ON "opex_lines"("projectId");

-- CreateIndex
CREATE INDEX "opex_lines_nextDueDate_idx" ON "opex_lines"("nextDueDate");

-- CreateIndex
CREATE INDEX "opex_payments_lineId_periodStart_idx" ON "opex_payments"("lineId", "periodStart");

-- CreateIndex
CREATE INDEX "opex_payments_paidAt_idx" ON "opex_payments"("paidAt");

-- CreateIndex
CREATE INDEX "capex_payments_lineId_idx" ON "capex_payments"("lineId");

-- CreateIndex
CREATE INDEX "capex_payments_dueDate_idx" ON "capex_payments"("dueDate");

-- CreateIndex
CREATE INDEX "pro_formas_tenantId_idx" ON "pro_formas"("tenantId");

-- CreateIndex
CREATE INDEX "pro_formas_conceptId_idx" ON "pro_formas"("conceptId");

-- CreateIndex
CREATE INDEX "pro_forma_channels_proFormaId_idx" ON "pro_forma_channels"("proFormaId");

-- CreateIndex
CREATE INDEX "pro_forma_fixed_costs_proFormaId_idx" ON "pro_forma_fixed_costs"("proFormaId");

-- CreateIndex
CREATE INDEX "pro_forma_months_proFormaId_idx" ON "pro_forma_months"("proFormaId");

-- CreateIndex
CREATE UNIQUE INDEX "pro_forma_months_proFormaId_monthIndex_key" ON "pro_forma_months"("proFormaId", "monthIndex");

-- CreateIndex
CREATE INDEX "projection_brand_inputs_projectionId_idx" ON "projection_brand_inputs"("projectionId");

-- CreateIndex
CREATE UNIQUE INDEX "projection_brand_inputs_projectionId_conceptId_key" ON "projection_brand_inputs"("projectionId", "conceptId");

-- CreateIndex
CREATE UNIQUE INDEX "domains_hostname_key" ON "domains"("hostname");

-- CreateIndex
CREATE INDEX "domains_tenantId_idx" ON "domains"("tenantId");

-- CreateIndex
CREATE INDEX "domains_conceptId_idx" ON "domains"("conceptId");

-- CreateIndex
CREATE INDEX "domains_status_idx" ON "domains"("status");

-- CreateIndex
CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants"("slug");

-- CreateIndex
CREATE INDEX "tenant_members_userId_idx" ON "tenant_members"("userId");

-- CreateIndex
CREATE INDEX "tenant_members_tenantId_idx" ON "tenant_members"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_members_userId_tenantId_key" ON "tenant_members"("userId", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "payment_gateway_configs_provider_conceptId_key" ON "payment_gateway_configs"("provider", "conceptId");

-- CreateIndex
CREATE UNIQUE INDEX "locations_slug_key" ON "locations"("slug");

-- CreateIndex
CREATE INDEX "stock_transfers_status_requestedAt_idx" ON "stock_transfers"("status", "requestedAt");

-- CreateIndex
CREATE INDEX "stock_transfers_inventoryItemId_idx" ON "stock_transfers"("inventoryItemId");

-- CreateIndex
CREATE INDEX "stock_transfers_fromLocationId_status_idx" ON "stock_transfers"("fromLocationId", "status");

-- CreateIndex
CREATE INDEX "stock_transfers_toLocationId_status_idx" ON "stock_transfers"("toLocationId", "status");

-- CreateIndex
CREATE INDEX "concept_locations_locationId_idx" ON "concept_locations"("locationId");

-- CreateIndex
CREATE INDEX "role_permissions_role_idx" ON "role_permissions"("role");

-- CreateIndex
CREATE UNIQUE INDEX "role_permissions_role_permission_key" ON "role_permissions"("role", "permission");

-- CreateIndex
CREATE INDEX "media_assets_category_createdAt_idx" ON "media_assets"("category", "createdAt");

-- CreateIndex
CREATE INDEX "goods_receipts_supplierId_receivedAt_idx" ON "goods_receipts"("supplierId", "receivedAt");

-- CreateIndex
CREATE INDEX "goods_receipts_status_idx" ON "goods_receipts"("status");

-- CreateIndex
CREATE INDEX "goods_receipt_lines_receiptId_idx" ON "goods_receipt_lines"("receiptId");

-- CreateIndex
CREATE INDEX "prep_batches_staffId_createdAt_idx" ON "prep_batches"("staffId", "createdAt");

-- CreateIndex
CREATE INDEX "prep_batches_recipeId_idx" ON "prep_batches"("recipeId");

-- CreateIndex
CREATE INDEX "physical_counts_countedAt_idx" ON "physical_counts"("countedAt");

-- CreateIndex
CREATE INDEX "physical_count_lines_countId_idx" ON "physical_count_lines"("countId");

-- CreateIndex
CREATE INDEX "physical_count_lines_inventoryItemId_idx" ON "physical_count_lines"("inventoryItemId");

-- CreateIndex
CREATE INDEX "exception_flags_status_severity_createdAt_idx" ON "exception_flags"("status", "severity", "createdAt");

-- CreateIndex
CREATE INDEX "exception_flags_kind_status_idx" ON "exception_flags"("kind", "status");

-- CreateIndex
CREATE INDEX "exception_flags_entityType_entityId_idx" ON "exception_flags"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "petty_cash_boxes_conceptId_idx" ON "petty_cash_boxes"("conceptId");

-- CreateIndex
CREATE INDEX "petty_cash_movements_boxId_createdAt_idx" ON "petty_cash_movements"("boxId", "createdAt");

-- CreateIndex
CREATE INDEX "deposit_drops_conceptId_droppedAt_idx" ON "deposit_drops"("conceptId", "droppedAt");

-- CreateIndex
CREATE INDEX "deposit_drops_shiftId_idx" ON "deposit_drops"("shiftId");

-- CreateIndex
CREATE INDEX "staff_meals_staffId_consumedAt_idx" ON "staff_meals"("staffId", "consumedAt");

-- CreateIndex
CREATE INDEX "staff_meals_conceptId_consumedAt_idx" ON "staff_meals"("conceptId", "consumedAt");

-- CreateIndex
CREATE INDEX "kitchen_staff_tenantId_status_idx" ON "kitchen_staff"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "kitchen_staff_tenantId_cnic_key" ON "kitchen_staff"("tenantId", "cnic");

-- CreateIndex
CREATE INDEX "kitchen_shifts_date_idx" ON "kitchen_shifts"("date");

-- CreateIndex
CREATE UNIQUE INDEX "kitchen_shifts_staffId_date_key" ON "kitchen_shifts"("staffId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "wage_settings_tenantId_key" ON "wage_settings"("tenantId");

-- CreateIndex
CREATE INDEX "kitchen_payroll_runs_tenantId_year_month_idx" ON "kitchen_payroll_runs"("tenantId", "year", "month");

-- CreateIndex
CREATE UNIQUE INDEX "kitchen_payroll_runs_staffId_month_year_key" ON "kitchen_payroll_runs"("staffId", "month", "year");

-- CreateIndex
CREATE INDEX "compliance_violations_tenantId_detectedAt_idx" ON "compliance_violations"("tenantId", "detectedAt" DESC);

-- CreateIndex
CREATE INDEX "compliance_violations_staffId_idx" ON "compliance_violations"("staffId");

-- CreateIndex
CREATE INDEX "departments_tenantId_archivedAt_idx" ON "departments"("tenantId", "archivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "departments_tenantId_name_key" ON "departments"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "shift_bands_tenantId_name_key" ON "shift_bands"("tenantId", "name");

-- CreateIndex
CREATE INDEX "tenant_contributions_destinationTenantId_isActive_idx" ON "tenant_contributions"("destinationTenantId", "isActive");

-- CreateIndex
CREATE INDEX "tenant_contributions_sourceTenantId_isActive_idx" ON "tenant_contributions"("sourceTenantId", "isActive");

-- CreateIndex
CREATE INDEX "positions_tenantId_status_idx" ON "positions"("tenantId", "status");

-- CreateIndex
CREATE INDEX "positions_conceptId_idx" ON "positions"("conceptId");

-- CreateIndex
CREATE INDEX "positions_departmentId_idx" ON "positions"("departmentId");

-- AddForeignKey
ALTER TABLE "concepts" ADD CONSTRAINT "concepts_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stations" ADD CONSTRAINT "stations_conceptId_fkey" FOREIGN KEY ("conceptId") REFERENCES "concepts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_conceptId_fkey" FOREIGN KEY ("conceptId") REFERENCES "concepts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_conceptId_fkey" FOREIGN KEY ("conceptId") REFERENCES "concepts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "modifier_groups" ADD CONSTRAINT "modifier_groups_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "menu_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "modifiers" ADD CONSTRAINT "modifiers_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "modifier_groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tables" ADD CONSTRAINT "tables_conceptId_fkey" FOREIGN KEY ("conceptId") REFERENCES "concepts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tables" ADD CONSTRAINT "tables_floorId_fkey" FOREIGN KEY ("floorId") REFERENCES "floors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "floors" ADD CONSTRAINT "floors_conceptId_fkey" FOREIGN KEY ("conceptId") REFERENCES "concepts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_conceptId_fkey" FOREIGN KEY ("conceptId") REFERENCES "concepts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "tables"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "concept_blockouts" ADD CONSTRAINT "concept_blockouts_conceptId_fkey" FOREIGN KEY ("conceptId") REFERENCES "concepts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_hours" ADD CONSTRAINT "service_hours_conceptId_fkey" FOREIGN KEY ("conceptId") REFERENCES "concepts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gift_card_redemptions" ADD CONSTRAINT "gift_card_redemptions_giftCardId_fkey" FOREIGN KEY ("giftCardId") REFERENCES "gift_cards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gift_card_redemptions" ADD CONSTRAINT "gift_card_redemptions_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guest_tags" ADD CONSTRAINT "guest_tags_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "shifts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expo_push_tokens" ADD CONSTRAINT "expo_push_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expo_push_tokens" ADD CONSTRAINT "expo_push_tokens_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clock_logs" ADD CONSTRAINT "clock_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_run_lines" ADD CONSTRAINT "payroll_run_lines_payrollRunId_fkey" FOREIGN KEY ("payrollRunId") REFERENCES "payroll_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_run_lines" ADD CONSTRAINT "payroll_run_lines_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_preferredConceptId_fkey" FOREIGN KEY ("preferredConceptId") REFERENCES "concepts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_referredById_fkey" FOREIGN KEY ("referredById") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_strikes" ADD CONSTRAINT "customer_strikes_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_bans" ADD CONSTRAINT "customer_bans_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_conversations" ADD CONSTRAINT "customer_conversations_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_conversations" ADD CONSTRAINT "customer_conversations_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_messages" ADD CONSTRAINT "customer_messages_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "customer_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_addresses" ADD CONSTRAINT "customer_addresses_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trigger_logs" ADD CONSTRAINT "trigger_logs_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback_entries" ADD CONSTRAINT "feedback_entries_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback_entries" ADD CONSTRAINT "feedback_entries_conceptId_fkey" FOREIGN KEY ("conceptId") REFERENCES "concepts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "magic_links" ADD CONSTRAINT "magic_links_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loyalty_accounts" ADD CONSTRAINT "loyalty_accounts_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loyalty_transactions" ADD CONSTRAINT "loyalty_transactions_loyaltyAccountId_fkey" FOREIGN KEY ("loyaltyAccountId") REFERENCES "loyalty_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loyalty_transactions" ADD CONSTRAINT "loyalty_transactions_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_conceptId_fkey" FOREIGN KEY ("conceptId") REFERENCES "concepts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "tables"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_posStaffId_fkey" FOREIGN KEY ("posStaffId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_riderId_fkey" FOREIGN KEY ("riderId") REFERENCES "riders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_promoCodeId_fkey" FOREIGN KEY ("promoCodeId") REFERENCES "promo_codes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "menu_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "stations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_item_modifiers" ADD CONSTRAINT "order_item_modifiers_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_item_modifiers" ADD CONSTRAINT "order_item_modifiers_modifierId_fkey" FOREIGN KEY ("modifierId") REFERENCES "modifiers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "shifts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tip_pool_members" ADD CONSTRAINT "tip_pool_members_poolId_fkey" FOREIGN KEY ("poolId") REFERENCES "tip_pools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tip_pool_members" ADD CONSTRAINT "tip_pool_members_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_orders" ADD CONSTRAINT "group_orders_conceptId_fkey" FOREIGN KEY ("conceptId") REFERENCES "concepts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_order_members" ADD CONSTRAINT "group_order_members_groupOrderId_fkey" FOREIGN KEY ("groupOrderId") REFERENCES "group_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_order_items" ADD CONSTRAINT "group_order_items_groupOrderId_fkey" FOREIGN KEY ("groupOrderId") REFERENCES "group_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_order_items" ADD CONSTRAINT "group_order_items_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "group_order_members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "waste_logs" ADD CONSTRAINT "waste_logs_inventoryItemId_fkey" FOREIGN KEY ("inventoryItemId") REFERENCES "inventory_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "waste_logs" ADD CONSTRAINT "waste_logs_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_assignedStaffId_fkey" FOREIGN KEY ("assignedStaffId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "menu_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipe_ingredients" ADD CONSTRAINT "recipe_ingredients_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "recipes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipe_ingredients" ADD CONSTRAINT "recipe_ingredients_inventoryItemId_fkey" FOREIGN KEY ("inventoryItemId") REFERENCES "inventory_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipe_ingredients" ADD CONSTRAINT "recipe_ingredients_prepRecipeId_fkey" FOREIGN KEY ("prepRecipeId") REFERENCES "recipes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipe_steps" ADD CONSTRAINT "recipe_steps_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "recipes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipe_steps" ADD CONSTRAINT "recipe_steps_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "stations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_item_steps" ADD CONSTRAINT "order_item_steps_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "order_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_item_steps" ADD CONSTRAINT "order_item_steps_recipeStepId_fkey" FOREIGN KEY ("recipeStepId") REFERENCES "recipe_steps"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "purchase_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_inventoryItemId_fkey" FOREIGN KEY ("inventoryItemId") REFERENCES "inventory_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "po_activity_log" ADD CONSTRAINT "po_activity_log_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "purchase_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "po_activity_log" ADD CONSTRAINT "po_activity_log_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receiving_discrepancies" ADD CONSTRAINT "receiving_discrepancies_poLineId_fkey" FOREIGN KEY ("poLineId") REFERENCES "purchase_order_lines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receiving_discrepancies" ADD CONSTRAINT "receiving_discrepancies_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_price_history" ADD CONSTRAINT "item_price_history_inventoryItemId_fkey" FOREIGN KEY ("inventoryItemId") REFERENCES "inventory_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_price_history" ADD CONSTRAINT "item_price_history_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_price_history" ADD CONSTRAINT "item_price_history_poLineId_fkey" FOREIGN KEY ("poLineId") REFERENCES "purchase_order_lines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_bills" ADD CONSTRAINT "supplier_bills_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_bills" ADD CONSTRAINT "supplier_bills_poId_fkey" FOREIGN KEY ("poId") REFERENCES "purchase_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_bill_lines" ADD CONSTRAINT "supplier_bill_lines_billId_fkey" FOREIGN KEY ("billId") REFERENCES "supplier_bills"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_bill_lines" ADD CONSTRAINT "supplier_bill_lines_inventoryItemId_fkey" FOREIGN KEY ("inventoryItemId") REFERENCES "inventory_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_bill_lines" ADD CONSTRAINT "supplier_bill_lines_poLineId_fkey" FOREIGN KEY ("poLineId") REFERENCES "purchase_order_lines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payment_applications" ADD CONSTRAINT "supplier_payment_applications_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "supplier_payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payment_applications" ADD CONSTRAINT "supplier_payment_applications_billId_fkey" FOREIGN KEY ("billId") REFERENCES "supplier_bills"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_importId_fkey" FOREIGN KEY ("importId") REFERENCES "bank_statement_imports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "allocation_rule_weights" ADD CONSTRAINT "allocation_rule_weights_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "cost_allocation_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "allocation_rule_weights" ADD CONSTRAINT "allocation_rule_weights_conceptId_fkey" FOREIGN KEY ("conceptId") REFERENCES "concepts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_allocation_runs" ADD CONSTRAINT "cost_allocation_runs_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "cost_allocation_rules"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_invoices" ADD CONSTRAINT "tax_invoices_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_invoices" ADD CONSTRAINT "tax_invoices_originalInvoiceId_fkey" FOREIGN KEY ("originalInvoiceId") REFERENCES "tax_invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_invoice_lines" ADD CONSTRAINT "tax_invoice_lines_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "tax_invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_entries" ADD CONSTRAINT "financial_entries_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_entries" ADD CONSTRAINT "financial_entries_conceptId_fkey" FOREIGN KEY ("conceptId") REFERENCES "concepts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_entries" ADD CONSTRAINT "financial_entries_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_segmentId_fkey" FOREIGN KEY ("segmentId") REFERENCES "segments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_sends" ADD CONSTRAINT "campaign_sends_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_sends" ADD CONSTRAINT "campaign_sends_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rider_ratings" ADD CONSTRAINT "rider_ratings_riderId_fkey" FOREIGN KEY ("riderId") REFERENCES "riders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rider_locations" ADD CONSTRAINT "rider_locations_riderId_fkey" FOREIGN KEY ("riderId") REFERENCES "riders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_reviews" ADD CONSTRAINT "order_reviews_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_reviews" ADD CONSTRAINT "order_reviews_conceptId_fkey" FOREIGN KEY ("conceptId") REFERENCES "concepts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_complaints" ADD CONSTRAINT "order_complaints_conceptId_fkey" FOREIGN KEY ("conceptId") REFERENCES "concepts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_complaints" ADD CONSTRAINT "order_complaints_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promo_codes" ADD CONSTRAINT "promo_codes_conceptId_fkey" FOREIGN KEY ("conceptId") REFERENCES "concepts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promo_code_usages" ADD CONSTRAINT "promo_code_usages_promoCodeId_fkey" FOREIGN KEY ("promoCodeId") REFERENCES "promo_codes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promo_code_usages" ADD CONSTRAINT "promo_code_usages_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "section_discounts" ADD CONSTRAINT "section_discounts_conceptId_fkey" FOREIGN KEY ("conceptId") REFERENCES "concepts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "section_discounts" ADD CONSTRAINT "section_discounts_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "abandoned_carts" ADD CONSTRAINT "abandoned_carts_conceptId_fkey" FOREIGN KEY ("conceptId") REFERENCES "concepts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qr_codes" ADD CONSTRAINT "qr_codes_conceptId_fkey" FOREIGN KEY ("conceptId") REFERENCES "concepts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qr_codes" ADD CONSTRAINT "qr_codes_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "tables"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_shifts" ADD CONSTRAINT "scheduled_shifts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_shifts" ADD CONSTRAINT "scheduled_shifts_conceptId_fkey" FOREIGN KEY ("conceptId") REFERENCES "concepts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_swap_requests" ADD CONSTRAINT "shift_swap_requests_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "scheduled_shifts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analytics_events" ADD CONSTRAINT "analytics_events_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analytics_events" ADD CONSTRAINT "analytics_events_conceptId_fkey" FOREIGN KEY ("conceptId") REFERENCES "concepts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_segment_memberships" ADD CONSTRAINT "customer_segment_memberships_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_segment_memberships" ADD CONSTRAINT "customer_segment_memberships_segmentId_fkey" FOREIGN KEY ("segmentId") REFERENCES "customer_segments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_events" ADD CONSTRAINT "content_events_conceptId_fkey" FOREIGN KEY ("conceptId") REFERENCES "concepts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_events" ADD CONSTRAINT "content_events_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_events" ADD CONSTRAINT "content_events_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_posts" ADD CONSTRAINT "social_posts_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "content_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_conversations" ADD CONSTRAINT "supplier_conversations_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_conversations" ADD CONSTRAINT "supplier_conversations_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_messages" ADD CONSTRAINT "supplier_messages_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "supplier_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_portal_tokens" ADD CONSTRAINT "supplier_portal_tokens_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "modifier_template_options" ADD CONSTRAINT "modifier_template_options_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "modifier_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "webhook_subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_field_values" ADD CONSTRAINT "custom_field_values_fieldId_fkey" FOREIGN KEY ("fieldId") REFERENCES "custom_field_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "components" ADD CONSTRAINT "components_baseIngredientId_fkey" FOREIGN KEY ("baseIngredientId") REFERENCES "inventory_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "component_par_levels" ADD CONSTRAINT "component_par_levels_componentId_fkey" FOREIGN KEY ("componentId") REFERENCES "components"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "component_brand_uses" ADD CONSTRAINT "component_brand_uses_componentId_fkey" FOREIGN KEY ("componentId") REFERENCES "components"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "component_brand_uses" ADD CONSTRAINT "component_brand_uses_conceptId_fkey" FOREIGN KEY ("conceptId") REFERENCES "concepts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "capex_lines" ADD CONSTRAINT "capex_lines_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "capex_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "capex_quotes" ADD CONSTRAINT "capex_quotes_lineId_fkey" FOREIGN KEY ("lineId") REFERENCES "capex_lines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opex_lines" ADD CONSTRAINT "opex_lines_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "opex_categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opex_payments" ADD CONSTRAINT "opex_payments_lineId_fkey" FOREIGN KEY ("lineId") REFERENCES "opex_lines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "capex_payments" ADD CONSTRAINT "capex_payments_lineId_fkey" FOREIGN KEY ("lineId") REFERENCES "capex_lines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pro_forma_channels" ADD CONSTRAINT "pro_forma_channels_proFormaId_fkey" FOREIGN KEY ("proFormaId") REFERENCES "pro_formas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pro_forma_fixed_costs" ADD CONSTRAINT "pro_forma_fixed_costs_proFormaId_fkey" FOREIGN KEY ("proFormaId") REFERENCES "pro_formas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pro_forma_months" ADD CONSTRAINT "pro_forma_months_proFormaId_fkey" FOREIGN KEY ("proFormaId") REFERENCES "pro_formas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projection_brand_inputs" ADD CONSTRAINT "projection_brand_inputs_projectionId_fkey" FOREIGN KEY ("projectionId") REFERENCES "projections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projection_brand_inputs" ADD CONSTRAINT "projection_brand_inputs_conceptId_fkey" FOREIGN KEY ("conceptId") REFERENCES "concepts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_members" ADD CONSTRAINT "tenant_members_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_members" ADD CONSTRAINT "tenant_members_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_inventoryItemId_fkey" FOREIGN KEY ("inventoryItemId") REFERENCES "inventory_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_fromLocationId_fkey" FOREIGN KEY ("fromLocationId") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_toLocationId_fkey" FOREIGN KEY ("toLocationId") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "concept_locations" ADD CONSTRAINT "concept_locations_conceptId_fkey" FOREIGN KEY ("conceptId") REFERENCES "concepts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "concept_locations" ADD CONSTRAINT "concept_locations_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "goods_receipts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "physical_count_lines" ADD CONSTRAINT "physical_count_lines_countId_fkey" FOREIGN KEY ("countId") REFERENCES "physical_counts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "petty_cash_movements" ADD CONSTRAINT "petty_cash_movements_boxId_fkey" FOREIGN KEY ("boxId") REFERENCES "petty_cash_boxes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kitchen_shifts" ADD CONSTRAINT "kitchen_shifts_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "kitchen_staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kitchen_payroll_runs" ADD CONSTRAINT "kitchen_payroll_runs_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "kitchen_staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_violations" ADD CONSTRAINT "compliance_violations_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "kitchen_staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "departments" ADD CONSTRAINT "departments_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_bands" ADD CONSTRAINT "shift_bands_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_contributions" ADD CONSTRAINT "tenant_contributions_sourceTenantId_fkey" FOREIGN KEY ("sourceTenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_contributions" ADD CONSTRAINT "tenant_contributions_destinationTenantId_fkey" FOREIGN KEY ("destinationTenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "positions" ADD CONSTRAINT "positions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "positions" ADD CONSTRAINT "positions_conceptId_fkey" FOREIGN KEY ("conceptId") REFERENCES "concepts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "positions" ADD CONSTRAINT "positions_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "positions" ADD CONSTRAINT "positions_shiftBandId_fkey" FOREIGN KEY ("shiftBandId") REFERENCES "shift_bands"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "positions" ADD CONSTRAINT "positions_filledByUserId_fkey" FOREIGN KEY ("filledByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ─── Raw-SQL objects (not expressible in schema.prisma) ──────────────────────

-- Race-proof booking: physically prevent two reservations from claiming the
-- same table at overlapping times. tsrange is IMMUTABLE (required for the gist
-- index); enforced only for active reservations with an assigned table.
ALTER TABLE "reservations"
  ADD CONSTRAINT "reservations_no_table_overlap"
  EXCLUDE USING gist (
    "tableId" WITH =,
    tsrange("startTime", "endTime", '[)') WITH &&
  )
  WHERE (
    "tableId" IS NOT NULL
    AND status IN ('booked', 'confirmed', 'seated')
  );

-- A recipe ingredient is exactly one of: an inventory item OR a prep recipe.
ALTER TABLE "recipe_ingredients"
  ADD CONSTRAINT "recipe_ingredients_one_source"
  CHECK (
    ("inventoryItemId" IS NOT NULL AND "prepRecipeId" IS NULL)
    OR
    ("inventoryItemId" IS NULL AND "prepRecipeId" IS NOT NULL)
  );
