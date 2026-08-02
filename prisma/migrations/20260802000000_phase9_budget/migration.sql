-- Фаза 9 (ТЗ 5.16) — бюджет: план расходов по категориям.
--
-- Две таблицы карты сущностей ТЗ 4: `Budget` (период, статус, автор)
-- и `BudgetCategory` (строка «статья → allocated»).
--
-- Колонки `spent` здесь нет намеренно: потраченное выводится из `expenses`
-- за период бюджета, и вторая копия того же числа требовала бы пересчёта
-- при каждой правке расхода (тот же разбор, что с `Debtor` в 0029
-- и статусом месяца оплаты).
--
-- Внешние ключи разведены: `CASCADE` на бюджет (строка вне плана ничего
-- не значит), `RESTRICT` на статью расхода (исчезнувшая статья оставила бы
-- план без предмета), `SET NULL` на автора — как во всей бухгалтерии.
--
-- SQL сгенерирован `prisma migrate diff --from-schema-datamodel …
-- --to-schema-datamodel … --script`; руками добавлена только эта шапка.
-- Сида нет: план у каждого центра свой.

-- CreateEnum
CREATE TYPE "BudgetStatus" AS ENUM ('DRAFT', 'ACTIVE', 'CLOSED');

-- CreateTable
CREATE TABLE "budgets" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "periodFrom" DATE NOT NULL,
    "periodTo" DATE NOT NULL,
    "status" "BudgetStatus" NOT NULL DEFAULT 'DRAFT',
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "budgets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budget_categories" (
    "id" UUID NOT NULL,
    "budgetId" UUID NOT NULL,
    "categoryId" UUID NOT NULL,
    "allocated" DECIMAL(12,2) NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "budget_categories_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "budgets_name_key" ON "budgets"("name");

-- CreateIndex
CREATE INDEX "budgets_status_idx" ON "budgets"("status");

-- CreateIndex
CREATE INDEX "budgets_periodFrom_periodTo_idx" ON "budgets"("periodFrom", "periodTo");

-- CreateIndex
CREATE INDEX "budget_categories_categoryId_idx" ON "budget_categories"("categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "budget_categories_budgetId_categoryId_key" ON "budget_categories"("budgetId", "categoryId");

-- AddForeignKey
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_categories" ADD CONSTRAINT "budget_categories_budgetId_fkey" FOREIGN KEY ("budgetId") REFERENCES "budgets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_categories" ADD CONSTRAINT "budget_categories_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "expense_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

