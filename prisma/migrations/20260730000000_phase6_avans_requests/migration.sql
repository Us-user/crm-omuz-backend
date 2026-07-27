-- Фаза 6: заявки на аванс (ТЗ 5.14, 5.16).
--
-- Подача заявки — Фаза 6 (`GET/POST/DELETE /employees/{id}/avans`), рассмотрение —
-- бухгалтерия (`/accounting/avans/{id}/approve|deny`, Фаза 9). Колонки рассмотрения
-- заведены сразу и необязательны: миграции данных они не требуют, а без них
-- Фазе 9 пришлось бы второй раз трогать ту же таблицу.
--
-- SQL сгенерирован `prisma migrate diff` из схемы; руками добавлена только эта шапка.

-- CreateEnum
CREATE TYPE "AvansStatus" AS ENUM ('PENDING', 'APPROVED', 'DENIED');

-- CreateTable
CREATE TABLE "avans_requests" (
    "id" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "month" DATE NOT NULL,
    "status" "AvansStatus" NOT NULL DEFAULT 'PENDING',
    "createdById" UUID,
    "reviewedById" UUID,
    "reviewedAt" TIMESTAMP(3),
    "reviewComment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "avans_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "avans_requests_employeeId_status_idx" ON "avans_requests"("employeeId", "status");

-- CreateIndex
CREATE INDEX "avans_requests_status_createdAt_idx" ON "avans_requests"("status", "createdAt");

-- CreateIndex
CREATE INDEX "avans_requests_month_idx" ON "avans_requests"("month");

-- AddForeignKey
ALTER TABLE "avans_requests" ADD CONSTRAINT "avans_requests_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "avans_requests" ADD CONSTRAINT "avans_requests_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "avans_requests" ADD CONSTRAINT "avans_requests_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

