-- Фаза 7 — победители месяца (ТЗ 5.13: «Winners of the last month (снимок месяца)»).
--
-- Единственная таблица успеваемости, которая хранит посчитанное: общий балл
-- и категория активности выводятся агрегатом на лету (сессия 0019), а снимок
-- месяца обязан пережить последующие правки журнала — иначе правка старой
-- недели задним числом переписала бы прошлогодних победителей.
--
-- SQL сгенерирован `prisma migrate diff --from-schema-datamodel … --script`;
-- руками добавлена только эта шапка. Сида нет: месяцы закрываются вручную.

-- CreateTable
CREATE TABLE "monthly_winners" (
    "id" UUID NOT NULL,
    "month" DATE NOT NULL,
    "studentId" UUID NOT NULL,
    "place" INTEGER NOT NULL,
    "averageScore" DECIMAL(7,2) NOT NULL,
    "weeksCount" INTEGER NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "monthly_winners_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "monthly_winners_month_place_idx" ON "monthly_winners"("month", "place");

-- CreateIndex
CREATE INDEX "monthly_winners_studentId_idx" ON "monthly_winners"("studentId");

-- CreateIndex
CREATE UNIQUE INDEX "monthly_winners_month_studentId_key" ON "monthly_winners"("month", "studentId");

-- AddForeignKey
ALTER TABLE "monthly_winners" ADD CONSTRAINT "monthly_winners_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "monthly_winners" ADD CONSTRAINT "monthly_winners_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;
