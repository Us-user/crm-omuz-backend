-- Фаза 9 (ТЗ 5.16) — платёжный контур бухгалтерии:
--   payment_types        — справочник способов оплаты («тип Cash/Alif»);
--   student_payments     — помесячное начисление = снимок Fee курса
--                          за (студент, группа, месяц) плюс скидка с причиной;
--   payment_transactions — полученные деньги: платёж по месяцу либо предоплата
--                          (chargeId IS NULL).
--
-- Колонки paidAmount/remainingAmount — осознанная денормализация (см. схему):
-- они пересчитываются той же транзакцией, что и любой платёж, и на них держатся
-- статус месяца («Not paid») и витрина должников.
--
-- Внешние ключи разведены: RESTRICT на студента, группу, начисление и способ
-- оплаты (касса не должна редеть молча), SET NULL на сотрудников-авторов.
-- SQL сгенерирован `prisma migrate diff` из схемы; руками добавлена только
-- эта шапка.

-- CreateTable
CREATE TABLE "payment_types" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "DirectoryStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_payments" (
    "id" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "groupId" UUID NOT NULL,
    "month" DATE NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "discount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "discountReason" TEXT,
    "paidAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "remainingAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "note" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "student_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_transactions" (
    "id" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "chargeId" UUID,
    "amount" DECIMAL(12,2) NOT NULL,
    "paidAt" DATE NOT NULL,
    "typeId" UUID,
    "comment" TEXT,
    "editReason" TEXT,
    "editedAt" TIMESTAMP(3),
    "editedById" UUID,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payment_types_name_key" ON "payment_types"("name");

-- CreateIndex
CREATE INDEX "payment_types_status_idx" ON "payment_types"("status");

-- CreateIndex
CREATE INDEX "student_payments_month_idx" ON "student_payments"("month");

-- CreateIndex
CREATE INDEX "student_payments_groupId_month_idx" ON "student_payments"("groupId", "month");

-- CreateIndex
CREATE INDEX "student_payments_studentId_idx" ON "student_payments"("studentId");

-- CreateIndex
CREATE INDEX "student_payments_remainingAmount_idx" ON "student_payments"("remainingAmount");

-- CreateIndex
CREATE UNIQUE INDEX "student_payments_studentId_groupId_month_key" ON "student_payments"("studentId", "groupId", "month");

-- CreateIndex
CREATE INDEX "payment_transactions_studentId_paidAt_idx" ON "payment_transactions"("studentId", "paidAt");

-- CreateIndex
CREATE INDEX "payment_transactions_chargeId_idx" ON "payment_transactions"("chargeId");

-- CreateIndex
CREATE INDEX "payment_transactions_paidAt_idx" ON "payment_transactions"("paidAt");

-- CreateIndex
CREATE INDEX "payment_transactions_typeId_idx" ON "payment_transactions"("typeId");

-- AddForeignKey
ALTER TABLE "student_payments" ADD CONSTRAINT "student_payments_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_payments" ADD CONSTRAINT "student_payments_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_payments" ADD CONSTRAINT "student_payments_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_chargeId_fkey" FOREIGN KEY ("chargeId") REFERENCES "student_payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_typeId_fkey" FOREIGN KEY ("typeId") REFERENCES "payment_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_editedById_fkey" FOREIGN KEY ("editedById") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

