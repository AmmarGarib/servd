-- HR module base layer: employee master, org units, documents, versioned
-- section formats, generic section records, payroll runs, letter templates.

-- CreateTable
CREATE TABLE "hr_employees" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeCode" TEXT NOT NULL,
    "userId" TEXT,
    "fullName" TEXT NOT NULL,
    "fatherHusbandName" TEXT,
    "cnic" TEXT,
    "cnicExpiry" TIMESTAMP(3),
    "dateOfBirth" TIMESTAMP(3),
    "gender" TEXT,
    "phone" TEXT,
    "personalEmail" TEXT,
    "departmentId" TEXT,
    "designationId" TEXT,
    "gradeId" TEXT,
    "locationId" TEXT,
    "managerId" TEXT,
    "employmentType" TEXT NOT NULL DEFAULT 'probation',
    "status" TEXT NOT NULL DEFAULT 'active',
    "joiningDate" TIMESTAMP(3),
    "probationEnd" TIMESTAMP(3),
    "confirmationDate" TIMESTAMP(3),
    "contractEnd" TIMESTAMP(3),
    "lastWorkingDay" TIMESTAMP(3),
    "noticePeriodDays" INTEGER,
    "basicSalaryCents" INTEGER NOT NULL DEFAULT 0,
    "grossSalaryCents" INTEGER NOT NULL DEFAULT 0,
    "monthlyTaxCents" INTEGER NOT NULL DEFAULT 0,
    "paymentMethod" TEXT,
    "bankName" TEXT,
    "iban" TEXT,
    "eobiNo" TEXT,
    "sessiNo" TEXT,
    "ntn" TEXT,
    "photoUrl" TEXT,
    "data" JSONB NOT NULL DEFAULT '{}',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hr_employees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hr_org_units" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "parentId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "data" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hr_org_units_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hr_documents" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "docType" TEXT NOT NULL,
    "title" TEXT,
    "fileUrl" TEXT,
    "issueDate" TIMESTAMP(3),
    "expiryDate" TIMESTAMP(3),
    "verifiedById" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hr_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hr_form_definitions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "section" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "fields" JSONB NOT NULL,
    "workflow" JSONB NOT NULL DEFAULT '[]',
    "stages" JSONB NOT NULL DEFAULT '[]',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hr_form_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hr_records" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "section" TEXT NOT NULL,
    "formVersion" INTEGER NOT NULL,
    "employeeId" TEXT,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "effectiveDate" TIMESTAMP(3),
    "quantity" DOUBLE PRECISION,
    "amountCents" INTEGER,
    "refId" TEXT,
    "category" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "stage" TEXT,
    "currentStep" INTEGER NOT NULL DEFAULT 0,
    "approvals" JSONB NOT NULL DEFAULT '[]',
    "data" JSONB NOT NULL DEFAULT '{}',
    "appliedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hr_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hr_payroll_runs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "settings" JSONB NOT NULL,
    "totals" JSONB NOT NULL DEFAULT '{}',
    "createdById" TEXT,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "lockedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hr_payroll_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hr_payslips" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "inputs" JSONB NOT NULL,
    "lines" JSONB NOT NULL,
    "grossCents" INTEGER NOT NULL,
    "earningsCents" INTEGER NOT NULL,
    "deductionsCents" INTEGER NOT NULL,
    "eobiEmployeeCents" INTEGER NOT NULL,
    "eobiEmployerCents" INTEGER NOT NULL,
    "netCents" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hr_payslips_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hr_letter_templates" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hr_letter_templates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "hr_employees_userId_key" ON "hr_employees"("userId");

-- CreateIndex
CREATE INDEX "hr_employees_tenantId_status_idx" ON "hr_employees"("tenantId", "status");

-- CreateIndex
CREATE INDEX "hr_employees_managerId_idx" ON "hr_employees"("managerId");

-- CreateIndex
CREATE UNIQUE INDEX "hr_employees_tenantId_employeeCode_key" ON "hr_employees"("tenantId", "employeeCode");

-- CreateIndex
CREATE INDEX "hr_org_units_tenantId_kind_idx" ON "hr_org_units"("tenantId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "hr_org_units_tenantId_kind_name_key" ON "hr_org_units"("tenantId", "kind", "name");

-- CreateIndex
CREATE INDEX "hr_documents_tenantId_expiryDate_idx" ON "hr_documents"("tenantId", "expiryDate");

-- CreateIndex
CREATE INDEX "hr_documents_employeeId_idx" ON "hr_documents"("employeeId");

-- CreateIndex
CREATE INDEX "hr_form_definitions_tenantId_section_isActive_idx" ON "hr_form_definitions"("tenantId", "section", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "hr_form_definitions_tenantId_section_version_key" ON "hr_form_definitions"("tenantId", "section", "version");

-- CreateIndex
CREATE INDEX "hr_records_tenantId_section_status_idx" ON "hr_records"("tenantId", "section", "status");

-- CreateIndex
CREATE INDEX "hr_records_employeeId_section_idx" ON "hr_records"("employeeId", "section");

-- CreateIndex
CREATE INDEX "hr_records_tenantId_section_startDate_idx" ON "hr_records"("tenantId", "section", "startDate");

-- CreateIndex
CREATE INDEX "hr_records_tenantId_section_category_idx" ON "hr_records"("tenantId", "section", "category");

-- CreateIndex
CREATE UNIQUE INDEX "hr_payroll_runs_tenantId_period_key" ON "hr_payroll_runs"("tenantId", "period");

-- CreateIndex
CREATE UNIQUE INDEX "hr_payslips_runId_employeeId_key" ON "hr_payslips"("runId", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "hr_letter_templates_tenantId_key_key" ON "hr_letter_templates"("tenantId", "key");

-- AddForeignKey
ALTER TABLE "hr_documents" ADD CONSTRAINT "hr_documents_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "hr_employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hr_records" ADD CONSTRAINT "hr_records_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "hr_employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hr_payslips" ADD CONSTRAINT "hr_payslips_runId_fkey" FOREIGN KEY ("runId") REFERENCES "hr_payroll_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hr_payslips" ADD CONSTRAINT "hr_payslips_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "hr_employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

