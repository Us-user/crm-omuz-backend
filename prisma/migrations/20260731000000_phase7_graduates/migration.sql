-- Фаза 7 — выпускники (ТЗ 5.11).
--
-- Заводится одна таблица `graduates` и перечисление статусов трудоустройства.
-- Отдельного `Certificate` из карты сущностей ТЗ 4 нет: сертификат — это
-- серийный номер и дата выдачи у того же выпуска, а PDF генерируется в Фазе 12
-- по шаблону и нигде не хранится (см. комментарий у модели в schema.prisma).
--
-- Уникальный индекс (groupId, studentId) делает автовыпуск идемпотентным:
-- повторное сохранение уже завершённой группы не заводит вторую строку.
--
-- Внешние ключи разведены: RESTRICT на студента и группу (выпуск не должен
-- исчезать вместе с ними), SET NULL на выдавшего сертификат сотрудника.
--
-- SQL сгенерирован `prisma migrate diff --from-schema-datamodel … --script`,
-- руками добавлена только эта шапка. Сида нет.

-- CreateEnum
CREATE TYPE "GraduateEmployment" AS ENUM ('OPEN_TO_WORK', 'WORK', 'FREELANCER', 'FURTHER_EDUCATION', 'ENTREPRENEUR');

-- CreateTable
CREATE TABLE "graduates" (
    "id" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "groupId" UUID NOT NULL,
    "graduatedAt" DATE NOT NULL,
    "points" DECIMAL(7,2),
    "weeksCount" INTEGER NOT NULL DEFAULT 0,
    "employment" "GraduateEmployment",
    "workPlace" TEXT,
    "certificateSerial" TEXT,
    "certificateIssuedAt" DATE,
    "certificateIssuedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "graduates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "graduates_certificateSerial_key" ON "graduates"("certificateSerial");

-- CreateIndex
CREATE INDEX "graduates_studentId_idx" ON "graduates"("studentId");

-- CreateIndex
CREATE INDEX "graduates_graduatedAt_idx" ON "graduates"("graduatedAt");

-- CreateIndex
CREATE INDEX "graduates_employment_idx" ON "graduates"("employment");

-- CreateIndex
CREATE UNIQUE INDEX "graduates_groupId_studentId_key" ON "graduates"("groupId", "studentId");

-- AddForeignKey
ALTER TABLE "graduates" ADD CONSTRAINT "graduates_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "graduates" ADD CONSTRAINT "graduates_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "graduates" ADD CONSTRAINT "graduates_certificateIssuedById_fkey" FOREIGN KEY ("certificateIssuedById") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

