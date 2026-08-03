-- Фаза 12 — Генерация документов (ТЗ 3.7, 5.3): договор студента.
--
-- Миграция дописана задним числом (сессия 0038): модель `Contract` и перечисление
-- `ContractStatus` попали в `schema.prisma` коммитом Фазы 12 (`46b1096`), а папки
-- миграции при нём не появилось. Из-за этого `prisma migrate deploy` таблицу
-- не создавал: схема и история миграций разъехались, и первый же запрос
-- к договорам на настоящей БД вернул бы «relation contracts does not exist».
-- SQL написан руками по формату Prisma и повторяет схему дословно.

-- CreateEnum
CREATE TYPE "ContractStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'TERMINATED');

-- CreateTable
CREATE TABLE "contracts" (
    "id" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "contractNumber" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "issuedAt" DATE NOT NULL,
    "validUntil" DATE,
    "status" "ContractStatus" NOT NULL DEFAULT 'ACTIVE',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contracts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "contracts_contractNumber_key" ON "contracts"("contractNumber");

-- CreateIndex
CREATE INDEX "contracts_studentId_idx" ON "contracts"("studentId");

-- CreateIndex
CREATE INDEX "contracts_status_idx" ON "contracts"("status");

-- AddForeignKey
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;
