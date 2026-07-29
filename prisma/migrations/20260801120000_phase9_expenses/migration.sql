-- Фаза 9 (ТЗ 5.16) — расходы бухгалтерии:
--   expense_categories — двухуровневый справочник статей расхода
--                        («Tax→Income tax/VAT/Property/Social, Office,
--                        Marketing, Employees»); глубину в два уровня
--                        держит сервис, схема лишь допускает родителя;
--   expenses           — сам расход: категория, сумма, день платежа,
--                        необязательный филиал.
--
-- Обобщённый `Transaction` из карты сущностей ТЗ 4 не заводится: приход уже
-- описан payment_transactions, и общая таблица на два потока потребовала бы
-- колонки-дискриминатора и половины полей, пустых по определению.
--
-- Внешние ключи: RESTRICT на категорию, родителя и филиал (отчёт о деньгах
-- не должен редеть молча), SET NULL на сотрудника-автора.
-- SQL сгенерирован `prisma migrate diff` из схемы; руками добавлены только
-- эта шапка и сид категорий в конце файла.

-- CreateTable
CREATE TABLE "expense_categories" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "parentId" UUID,
    "status" "DirectoryStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "expense_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expenses" (
    "id" UUID NOT NULL,
    "categoryId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "spentAt" DATE NOT NULL,
    "branchId" UUID,
    "note" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "expenses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "expense_categories_name_key" ON "expense_categories"("name");

-- CreateIndex
CREATE INDEX "expense_categories_parentId_idx" ON "expense_categories"("parentId");

-- CreateIndex
CREATE INDEX "expense_categories_status_idx" ON "expense_categories"("status");

-- CreateIndex
CREATE INDEX "expenses_spentAt_idx" ON "expenses"("spentAt");

-- CreateIndex
CREATE INDEX "expenses_categoryId_spentAt_idx" ON "expenses"("categoryId", "spentAt");

-- CreateIndex
CREATE INDEX "expenses_branchId_idx" ON "expenses"("branchId");

-- AddForeignKey
ALTER TABLE "expense_categories" ADD CONSTRAINT "expense_categories_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "expense_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "expense_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Сид: статьи расхода, названные в ТЗ 5.16 (решение пользователя, сессия 0030).
--
-- В отличие от способов оплаты (0029, «у каждого центра свои»), этот перечень
-- задан самим ТЗ, поэтому центр получает его из коробки. Строки при этом
-- обычные, а не системные: их можно переименовать, вывести из работы
-- и дополнить своими — флага «системная» здесь нет, потому что он не давал бы
-- ничего, кроме запрета трогать то, что ТЗ не запрещает трогать.
--
-- Названия русские (язык интерфейса), термин ТЗ — в описании: по нему статья
-- узнаётся при сверке с требованиями.
INSERT INTO "expense_categories" ("id", "name", "description", "parentId", "status", "createdAt", "updatedAt")
VALUES (gen_random_uuid(), 'Налоги', 'Tax (ТЗ 5.16) — свод налоговых статей', NULL, 'ACTIVE', now(), now());

INSERT INTO "expense_categories" ("id", "name", "description", "parentId", "status", "createdAt", "updatedAt")
SELECT gen_random_uuid(), child."name", child."description", parent."id", 'ACTIVE', now(), now()
FROM (
  VALUES
    ('Подоходный налог', 'Income tax (ТЗ 5.16)'),
    ('НДС', 'VAT (ТЗ 5.16)'),
    ('Налог на имущество', 'Property tax (ТЗ 5.16)'),
    ('Социальный налог', 'Social tax (ТЗ 5.16)')
) AS child ("name", "description")
CROSS JOIN (SELECT "id" FROM "expense_categories" WHERE "name" = 'Налоги') AS parent;

INSERT INTO "expense_categories" ("id", "name", "description", "parentId", "status", "createdAt", "updatedAt")
SELECT gen_random_uuid(), root."name", root."description", NULL, 'ACTIVE', now(), now()
FROM (
  VALUES
    ('Офис', 'Office (ТЗ 5.16) — аренда, коммунальные, хозяйственные расходы'),
    ('Маркетинг', 'Marketing (ТЗ 5.16) — реклама и продвижение'),
    ('Сотрудники', 'Employees (ТЗ 5.16) — выплаты персоналу сверх зарплатной ведомости')
) AS root ("name", "description");
