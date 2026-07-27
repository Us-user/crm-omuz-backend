-- Фаза 5 (ТЗ 5.8, 5.9): журнал/Progressbook, успеваемость и коины.
--
-- Неделя журнала (`journal_weeks`) — «NEW WEEK» из ТЗ 5.8. Её учебные дни лежат
-- отдельной таблицей (`journal_days`): без неё день, в который занятие было,
-- но никого ещё не отметили, не существовал бы, и «отметить всех
-- присутствующими» нечего было бы заполнять. Тип дня переиспользует
-- `LessonType` из силлабуса — на `EXAM` приход не начисляется (ТЗ 5.8).
--
-- Клетка журнала (`journal_entries`) ссылается на **студента**, а не на членство
-- `group_students`: исключение из состава группы (ТЗ 5.5) не должно каскадом
-- стирать уже проставленные баллы. Группа известна из недели.
--
-- Итог недели (`week_results`) хранит `sum` (`Σ(приходы) + Σ(ДЗ) + Exam + Bonus`)
-- рядом с ручными слагаемыми: общий балл студента — это среднее `sum` по всем
-- неделям (ТЗ 5.8), и рейтинг центра (ТЗ 5.13) иначе собирался бы обходом всех
-- клеток журнала. Значение пересчитывается той же транзакцией, что и любое
-- изменение недели.
--
-- Коины (ТЗ 5.9): списание запрещено, поэтому `coin_balances.balance` только
-- растёт и равен сумме начислений. Уникальный индекс
-- `coin_transactions_weekId_studentId_key` не пускает второе автоначисление
-- за ту же неделю; у ручных начислений `weekId` равен NULL, а NULL-ы
-- в PostgreSQL друг с другом не конфликтуют — ручных строк это не задевает.

-- CreateEnum
CREATE TYPE "AttendanceMark" AS ENUM ('PRESENT', 'LATE', 'ABSENT');

-- CreateEnum
CREATE TYPE "CoinSource" AS ENUM ('MANUAL', 'WEEK_RESULT');

-- CreateTable
CREATE TABLE "journal_weeks" (
    "id" UUID NOT NULL,
    "groupId" UUID NOT NULL,
    "weekNumber" INTEGER NOT NULL,
    "startDate" DATE NOT NULL,
    "submittedAt" TIMESTAMP(3),
    "submittedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "journal_weeks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_days" (
    "id" UUID NOT NULL,
    "weekId" UUID NOT NULL,
    "date" DATE NOT NULL,
    "type" "LessonType" NOT NULL DEFAULT 'LECTURE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "journal_days_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_entries" (
    "id" UUID NOT NULL,
    "dayId" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "attendance" "AttendanceMark",
    "score" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "journal_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "week_results" (
    "weekId" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "bonus" INTEGER NOT NULL DEFAULT 0,
    "exam" INTEGER NOT NULL DEFAULT 0,
    "sum" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "week_results_pkey" PRIMARY KEY ("weekId","studentId")
);

-- CreateTable
CREATE TABLE "coin_balances" (
    "studentId" UUID NOT NULL,
    "balance" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "coin_balances_pkey" PRIMARY KEY ("studentId")
);

-- CreateTable
CREATE TABLE "coin_transactions" (
    "id" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "amount" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "source" "CoinSource" NOT NULL,
    "weekId" UUID,
    "authorId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coin_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "journal_weeks_groupId_startDate_idx" ON "journal_weeks"("groupId", "startDate");

-- CreateIndex
CREATE UNIQUE INDEX "journal_weeks_groupId_weekNumber_key" ON "journal_weeks"("groupId", "weekNumber");

-- CreateIndex
CREATE UNIQUE INDEX "journal_days_weekId_date_key" ON "journal_days"("weekId", "date");

-- CreateIndex
CREATE INDEX "journal_entries_studentId_idx" ON "journal_entries"("studentId");

-- CreateIndex
CREATE UNIQUE INDEX "journal_entries_dayId_studentId_key" ON "journal_entries"("dayId", "studentId");

-- CreateIndex
CREATE INDEX "week_results_studentId_idx" ON "week_results"("studentId");

-- CreateIndex
CREATE INDEX "coin_transactions_studentId_createdAt_idx" ON "coin_transactions"("studentId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "coin_transactions_weekId_studentId_key" ON "coin_transactions"("weekId", "studentId");

-- AddForeignKey
ALTER TABLE "journal_weeks" ADD CONSTRAINT "journal_weeks_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_weeks" ADD CONSTRAINT "journal_weeks_submittedById_fkey" FOREIGN KEY ("submittedById") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_days" ADD CONSTRAINT "journal_days_weekId_fkey" FOREIGN KEY ("weekId") REFERENCES "journal_weeks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_dayId_fkey" FOREIGN KEY ("dayId") REFERENCES "journal_days"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "week_results" ADD CONSTRAINT "week_results_weekId_fkey" FOREIGN KEY ("weekId") REFERENCES "journal_weeks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "week_results" ADD CONSTRAINT "week_results_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coin_balances" ADD CONSTRAINT "coin_balances_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coin_transactions" ADD CONSTRAINT "coin_transactions_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coin_transactions" ADD CONSTRAINT "coin_transactions_weekId_fkey" FOREIGN KEY ("weekId") REFERENCES "journal_weeks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coin_transactions" ADD CONSTRAINT "coin_transactions_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

