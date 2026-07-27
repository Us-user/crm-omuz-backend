-- Фаза 6 (ТЗ 5.14, 5.4): уровни ментора и их история по месяцам.
--
-- `mentor_levels` — справочник ступеней центра: название, описание, **часовая
-- ставка** и статус. Ставка живёт здесь, а не у сотрудника: её пересматривают
-- для всей лестницы разом, и копия у каждого человека означала бы правку
-- N строк вместо одной.
--
-- `mentor_level_history` — уровень сотрудника в конкретном месяце. Помесячность
-- прямо требуется ТЗ 5.14 («история по месяцам → зарплата по уровню месяца»):
-- в Фазе 9 зарплата считается как «часы × ставка уровня **того** месяца»
-- (ТЗ 5.16), и один «текущий уровень» задним числом менял бы суммы за все
-- прошлые месяцы сразу.
--
-- Месяц хранится датой (`DATE`, первое число) — сравнение периодов и выборка
-- «уровни за квартал» тогда выражаются обычным диапазоном, а не арифметикой
-- над парой чисел. Наружу он уходит как `YYYY-MM`.
--
-- Уникальный индекс `(employeeId, month)` — одна запись на сотрудника в месяц:
-- две строки о ставке одного месяца заставили бы расчёт зарплаты выбирать
-- между ними. Внешние ключи разведены осознанно: `CASCADE` на сотрудника
-- (помесячный уровень — часть кадровой карточки), `RESTRICT` на уровень
-- (ступень, по которой уже считали зарплату, не должна исчезать из справочника).
--
-- SQL сгенерирован `prisma migrate diff --from-schema-datamodel …
-- --to-schema-datamodel … --script`; руками добавлена только эта шапка.
-- Сида нет: лестница уровней и ставки у каждого центра свои.

-- CreateTable
CREATE TABLE "mentor_levels" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "hourlyRate" DECIMAL(12,2) NOT NULL,
    "status" "DirectoryStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mentor_levels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mentor_level_history" (
    "id" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "levelId" UUID NOT NULL,
    "month" DATE NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mentor_level_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "mentor_levels_name_key" ON "mentor_levels"("name");

-- CreateIndex
CREATE INDEX "mentor_levels_status_idx" ON "mentor_levels"("status");

-- CreateIndex
CREATE INDEX "mentor_level_history_levelId_idx" ON "mentor_level_history"("levelId");

-- CreateIndex
CREATE INDEX "mentor_level_history_month_idx" ON "mentor_level_history"("month");

-- CreateIndex
CREATE UNIQUE INDEX "mentor_level_history_employeeId_month_key" ON "mentor_level_history"("employeeId", "month");

-- AddForeignKey
ALTER TABLE "mentor_level_history" ADD CONSTRAINT "mentor_level_history_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mentor_level_history" ADD CONSTRAINT "mentor_level_history_levelId_fkey" FOREIGN KEY ("levelId") REFERENCES "mentor_levels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

