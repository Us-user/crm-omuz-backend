-- Фаза 9 · Бухгалтерия (ТЗ 5.16): финансовые периоды-отчёты.
--
-- Одна таблица и один enum. `AccountingPeriod` — документ с собственным
-- периодом (месяцы, обе границы включительно) и статусом Inprogress→Archive.
-- Пять колонок снимка (charged/paid/income/expense/salary) заполняются при
-- закрытии и гасятся при возврате в работу: закрытый отчёт не должен меняться
-- от правки расхода задним числом. «Долг» и «итог» не хранятся — они
-- выводятся из этих пяти теми же функциями, что и у живого периода.
--
-- Сида нет: периоды отчётности у каждого центра свои.
-- SQL сгенерирован `prisma migrate diff` из схемы; руками добавлена только
-- эта шапка.

-- CreateEnum
CREATE TYPE "AccountingPeriodStatus" AS ENUM ('IN_PROGRESS', 'ARCHIVED');

-- CreateTable
CREATE TABLE "accounting_periods" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "periodFrom" DATE NOT NULL,
    "periodTo" DATE NOT NULL,
    "status" "AccountingPeriodStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "charged" DECIMAL(14,2),
    "paid" DECIMAL(14,2),
    "income" DECIMAL(14,2),
    "expense" DECIMAL(14,2),
    "salary" DECIMAL(14,2),
    "closedAt" TIMESTAMP(3),
    "closedById" UUID,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "accounting_periods_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "accounting_periods_name_key" ON "accounting_periods"("name");

-- CreateIndex
CREATE INDEX "accounting_periods_status_periodFrom_periodTo_idx" ON "accounting_periods"("status", "periodFrom", "periodTo");

-- CreateIndex
CREATE INDEX "accounting_periods_periodFrom_periodTo_idx" ON "accounting_periods"("periodFrom", "periodTo");

-- AddForeignKey
ALTER TABLE "accounting_periods" ADD CONSTRAINT "accounting_periods_closedById_fkey" FOREIGN KEY ("closedById") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounting_periods" ADD CONSTRAINT "accounting_periods_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

