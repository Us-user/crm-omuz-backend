-- Фаза 3 — учебный контур, справочники (ТЗ 5.6, 5.10, 5.17).
--
-- `branches` — филиалы; `rooms` — аудитории филиала (источник поля «Room»
-- в расписании); `courses` — каталог курсов со стоимостью и длительностью.
--
-- Студенты и сотрудники получают необязательную ссылку на филиал (ТЗ 3.3:
-- «сущности привязаны к филиалу»). Ссылка `RESTRICT`, а не `SET NULL`:
-- удаление филиала не должно молча обезличивать людей — сервис отвечает 409
-- и просит сначала перевести их в другой филиал.
--
-- Справочники сидом не наполняются: филиалы, аудитории и курсы у каждого центра
-- свои, а первый Director заводится скриптом `npm run seed:admin`.

-- CreateEnum
CREATE TYPE "DirectoryStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "DurationUnit" AS ENUM ('DAY', 'WEEK', 'MONTH');

-- AlterTable
ALTER TABLE "students" ADD COLUMN     "branchId" UUID;

-- AlterTable
ALTER TABLE "employees" ADD COLUMN     "branchId" UUID;

-- CreateTable
CREATE TABLE "branches" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "district" TEXT,
    "address" TEXT NOT NULL,
    "phone" TEXT,
    "description" TEXT,
    "status" "DirectoryStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "branches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rooms" (
    "id" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "capacity" INTEGER,
    "floor" INTEGER,
    "description" TEXT,
    "status" "DirectoryStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rooms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "courses" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "subtitle" TEXT,
    "description" TEXT,
    "fee" DECIMAL(12,2) NOT NULL,
    "isLastCourse" BOOLEAN NOT NULL DEFAULT false,
    "colorPrimary" TEXT,
    "colorSecondary" TEXT,
    "logoUrl" TEXT,
    "durationValue" INTEGER NOT NULL,
    "durationUnit" "DurationUnit" NOT NULL DEFAULT 'MONTH',
    "status" "DirectoryStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "courses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "branches_name_key" ON "branches"("name");

-- CreateIndex
CREATE INDEX "branches_status_idx" ON "branches"("status");

-- CreateIndex
CREATE INDEX "rooms_branchId_idx" ON "rooms"("branchId");

-- CreateIndex
CREATE INDEX "rooms_status_idx" ON "rooms"("status");

-- CreateIndex
CREATE UNIQUE INDEX "rooms_branchId_name_key" ON "rooms"("branchId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "courses_title_key" ON "courses"("title");

-- CreateIndex
CREATE INDEX "courses_status_idx" ON "courses"("status");

-- CreateIndex
CREATE INDEX "courses_isLastCourse_idx" ON "courses"("isLastCourse");

-- CreateIndex
CREATE INDEX "students_branchId_idx" ON "students"("branchId");

-- CreateIndex
CREATE INDEX "employees_branchId_idx" ON "employees"("branchId");

-- AddForeignKey
ALTER TABLE "students" ADD CONSTRAINT "students_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

