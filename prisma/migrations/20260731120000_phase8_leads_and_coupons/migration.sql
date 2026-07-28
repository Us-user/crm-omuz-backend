-- Фаза 8 — маркетинговый контур: лиды и купоны (ТЗ 5.7).
--
-- Заводятся три таблицы (`leads`, `coupons`, `coupon_courses`) и перечисление
-- стадии обращения `LeadType` (Lead → Client, ТЗ 5.7). Полноценной машины
-- состояний воронки нет намеренно: ТЗ такого перечисления не даёт, а выдуманные
-- статусы легли бы в основу отчётов Фазы 10.
--
-- `leads.phone` **не уникален**, в отличие от `students.phone`: одно и то же
-- обращение может повториться через полгода, и вторая строка — это второй лид,
-- а не дубликат. Уникален только `convertedStudentId`: одно обращение даёт
-- одного студента.
--
-- Внешние ключи разведены: RESTRICT на курс, купон, филиал и профиль студента
-- (справочник с обращениями не исчезает молча, а переведённый лид не должен
-- задним числом становиться непереведённым), CASCADE — только на купон
-- в связке `coupon_courses`: набор курсов это часть самого купона.
--
-- SQL сгенерирован `prisma migrate diff --from-schema-datamodel … --script`,
-- руками добавлена только эта шапка. Сида нет: купоны у каждого центра свои.

-- CreateEnum
CREATE TYPE "LeadType" AS ENUM ('LEAD', 'CLIENT');

-- CreateTable
CREATE TABLE "leads" (
    "id" UUID NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "birthDate" DATE,
    "gender" "Gender",
    "occupation" TEXT,
    "enrollMonth" DATE,
    "courseId" UUID,
    "lessonTimeMinute" INTEGER,
    "notes" TEXT,
    "source" TEXT,
    "utmSource" TEXT,
    "utmMedium" TEXT,
    "utmCampaign" TEXT,
    "couponId" UUID,
    "branchId" UUID,
    "type" "LeadType" NOT NULL DEFAULT 'LEAD',
    "becameClientAt" TIMESTAMP(3),
    "convertedStudentId" UUID,
    "convertedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "leads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coupons" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "amount" DECIMAL(12,2) NOT NULL,
    "validFrom" DATE,
    "validTo" DATE,
    "status" "DirectoryStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "coupons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coupon_courses" (
    "couponId" UUID NOT NULL,
    "courseId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coupon_courses_pkey" PRIMARY KEY ("couponId","courseId")
);

-- CreateIndex
CREATE UNIQUE INDEX "leads_convertedStudentId_key" ON "leads"("convertedStudentId");

-- CreateIndex
CREATE INDEX "leads_phone_idx" ON "leads"("phone");

-- CreateIndex
CREATE INDEX "leads_type_createdAt_idx" ON "leads"("type", "createdAt");

-- CreateIndex
CREATE INDEX "leads_enrollMonth_idx" ON "leads"("enrollMonth");

-- CreateIndex
CREATE INDEX "leads_courseId_idx" ON "leads"("courseId");

-- CreateIndex
CREATE INDEX "leads_branchId_idx" ON "leads"("branchId");

-- CreateIndex
CREATE INDEX "leads_couponId_idx" ON "leads"("couponId");

-- CreateIndex
CREATE UNIQUE INDEX "coupons_name_key" ON "coupons"("name");

-- CreateIndex
CREATE INDEX "coupons_status_idx" ON "coupons"("status");

-- CreateIndex
CREATE INDEX "coupons_validFrom_validTo_idx" ON "coupons"("validFrom", "validTo");

-- CreateIndex
CREATE INDEX "coupon_courses_courseId_idx" ON "coupon_courses"("courseId");

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "courses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "coupons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_convertedStudentId_fkey" FOREIGN KEY ("convertedStudentId") REFERENCES "students"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupon_courses" ADD CONSTRAINT "coupon_courses_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "coupons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupon_courses" ADD CONSTRAINT "coupon_courses_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "courses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

