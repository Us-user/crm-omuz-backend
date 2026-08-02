-- Фаза 9 (ТЗ 5.16) — зарплата: часы у дня журнала и расчёт по месяцам.
--
-- Три изменения, и первое из них — ответ на развилку, тянувшуюся с сессии 0011:
-- **откуда берутся часы ментора**. ТЗ 5.16 требует «часы по фактически
-- проведённым занятиям», и по решению пользователя (сессия 0032) они живут
-- у учебного дня журнала — `journal_days.mentorId` и `journal_days.durationMinutes`.
-- Расписание для этого не годится: слот описывает план, а журнал фиксирует факт
-- (решение 0018), и считать зарплату по плану значило бы платить за занятия,
-- которых не было. `SET NULL` на сотрудника: увольнение не переписывает прошлое.
--
-- Второе — две таблицы карты сущностей ТЗ 4: `Salary` (расчёт «сотрудник ×
-- месяц») и `SalaryTransaction` (выплата). Ни `Total`, ни `Prepaid`, ни `Paid`,
-- ни `Remaining` в черновике не хранятся: первое считается из журнала и ставки
-- уровня месяца (0021), второе — из одобренных заявок на аванс (0022, 0031),
-- третье — из выплат. Колонки `minutes`/`hourlyRate`/`total` заполняются только
-- при подтверждении Done и работают снимком — после него правка журнала или
-- ставки справочника не двигает уже названную человеку сумму (тот же довод,
-- что у `MonthlyWinner` в 0024 и `Graduate.points` в 0026).
--
-- `DailySalary` из карты ТЗ 4 не заводится: дневная строка — это учебный день
-- журнала с этим ведущим, и вторая таблица была бы копией журнала.
--
-- Третье — `budgets.salaryAllocated`: план фонда оплаты труда стоит **полем
-- документа**, а не строкой `budget_categories`, потому что выплата зарплаты
-- не заводит `expenses` (решение пользователя, 0032), а у строки плана
-- обязательно есть статья расхода. `spent` для него, как и для остальных строк,
-- не хранится, а считается по выплатам периода.
--
-- Внешние ключи разведены: `CASCADE` на сотрудника расчёта (расчёт — часть
-- кадровой карточки, как уровень 0021 и заявка 0022), `RESTRICT` на расчёт
-- и способ оплаты со стороны выплаты (деньги не должны повисать без месяца
-- и без названия), `SET NULL` на авторов — как во всей бухгалтерии.
--
-- SQL сгенерирован `prisma migrate diff --from-schema-datamodel …
-- --to-schema-datamodel … --script`; руками добавлена только эта шапка.
-- Сида нет: расчёты заводятся действием «сформировать ведомость месяца».

-- CreateEnum
CREATE TYPE "SalaryStatus" AS ENUM ('DRAFT', 'DONE');

-- AlterTable
ALTER TABLE "journal_days" ADD COLUMN     "durationMinutes" INTEGER,
ADD COLUMN     "mentorId" UUID;

-- AlterTable
ALTER TABLE "budgets" ADD COLUMN     "salaryAllocated" DECIMAL(12,2);

-- CreateTable
CREATE TABLE "salaries" (
    "id" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "month" DATE NOT NULL,
    "bonus" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "note" TEXT,
    "status" "SalaryStatus" NOT NULL DEFAULT 'DRAFT',
    "minutes" INTEGER,
    "hourlyRate" DECIMAL(12,2),
    "total" DECIMAL(12,2),
    "confirmedAt" TIMESTAMP(3),
    "confirmedById" UUID,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "salaries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salary_transactions" (
    "id" UUID NOT NULL,
    "salaryId" UUID NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "paidAt" DATE NOT NULL,
    "typeId" UUID NOT NULL,
    "comment" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "salary_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "salaries_month_status_idx" ON "salaries"("month", "status");

-- CreateIndex
CREATE INDEX "salaries_employeeId_idx" ON "salaries"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "salaries_employeeId_month_key" ON "salaries"("employeeId", "month");

-- CreateIndex
CREATE INDEX "salary_transactions_salaryId_idx" ON "salary_transactions"("salaryId");

-- CreateIndex
CREATE INDEX "salary_transactions_paidAt_idx" ON "salary_transactions"("paidAt");

-- CreateIndex
CREATE INDEX "salary_transactions_typeId_idx" ON "salary_transactions"("typeId");

-- CreateIndex
CREATE INDEX "journal_days_mentorId_date_idx" ON "journal_days"("mentorId", "date");

-- AddForeignKey
ALTER TABLE "journal_days" ADD CONSTRAINT "journal_days_mentorId_fkey" FOREIGN KEY ("mentorId") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salaries" ADD CONSTRAINT "salaries_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salaries" ADD CONSTRAINT "salaries_confirmedById_fkey" FOREIGN KEY ("confirmedById") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salaries" ADD CONSTRAINT "salaries_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salary_transactions" ADD CONSTRAINT "salary_transactions_salaryId_fkey" FOREIGN KEY ("salaryId") REFERENCES "salaries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salary_transactions" ADD CONSTRAINT "salary_transactions_typeId_fkey" FOREIGN KEY ("typeId") REFERENCES "payment_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salary_transactions" ADD CONSTRAINT "salary_transactions_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

