-- Фаза 3 — учебные группы (ТЗ 5.5).
--
-- Группа ссылается на курс и на филиал, обе связи обязательны и RESTRICT:
-- удалить курс или филиал, за которым числятся группы, нельзя (сервисы
-- проверяют это заранее и отвечают 409 с перечислением причин).
--
-- Название уникально внутри филиала — как у аудиторий: «Frontend-1» набирают
-- в каждом филиале. Сида нет: группы у каждого центра свои.

-- CreateEnum
CREATE TYPE "GroupFormat" AS ENUM ('ONLINE', 'OFFLINE');

-- CreateEnum
CREATE TYPE "GroupStatus" AS ENUM ('RECRUITING', 'ACTIVE', 'FINISHED', 'CANCELLED');

-- CreateTable
CREATE TABLE "groups" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "courseId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "format" "GroupFormat" NOT NULL DEFAULT 'OFFLINE',
    "startDate" DATE,
    "endDate" DATE,
    "durationValue" INTEGER,
    "durationUnit" "DurationUnit" NOT NULL DEFAULT 'MONTH',
    "capacity" INTEGER,
    "status" "GroupStatus" NOT NULL DEFAULT 'RECRUITING',
    "telegramUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "groups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "groups_courseId_idx" ON "groups"("courseId");

-- CreateIndex
CREATE INDEX "groups_status_idx" ON "groups"("status");

-- CreateIndex
CREATE INDEX "groups_startDate_idx" ON "groups"("startDate");

-- CreateIndex
CREATE UNIQUE INDEX "groups_branchId_name_key" ON "groups"("branchId", "name");

-- AddForeignKey
ALTER TABLE "groups" ADD CONSTRAINT "groups_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "courses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "groups" ADD CONSTRAINT "groups_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

