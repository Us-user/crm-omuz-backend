-- Фаза 2 — роли, позиции и права (ТЗ 3.2, 5.15).
--
-- Позиция = роль доступа; права сотрудника = объединение прав всех его позиций.
-- Каталог прав (`permissions`) наполняется не здесь, а при старте приложения
-- из `src/rbac/permission-catalog.ts`: коды прав растут вместе с эндпоинтами,
-- и держать их ещё и в миграциях значило бы вести один список в двух местах.
-- В конце файла — стартовый справочник позиций из ТЗ 3.2 (одноразовый сид).

-- CreateTable
CREATE TABLE "permissions" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "section" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "description" TEXT,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "positions" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "positions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "position_permissions" (
    "positionId" UUID NOT NULL,
    "permissionId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "position_permissions_pkey" PRIMARY KEY ("positionId","permissionId")
);

-- CreateTable
CREATE TABLE "employee_positions" (
    "employeeId" UUID NOT NULL,
    "positionId" UUID NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_positions_pkey" PRIMARY KEY ("employeeId","positionId")
);

-- CreateIndex
CREATE UNIQUE INDEX "permissions_code_key" ON "permissions"("code");

-- CreateIndex
CREATE INDEX "permissions_section_idx" ON "permissions"("section");

-- CreateIndex
CREATE UNIQUE INDEX "positions_name_key" ON "positions"("name");

-- CreateIndex
CREATE INDEX "position_permissions_permissionId_idx" ON "position_permissions"("permissionId");

-- CreateIndex
CREATE INDEX "employee_positions_positionId_idx" ON "employee_positions"("positionId");

-- AddForeignKey
ALTER TABLE "position_permissions" ADD CONSTRAINT "position_permissions_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "positions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "position_permissions" ADD CONSTRAINT "position_permissions_permissionId_fkey" FOREIGN KEY ("permissionId") REFERENCES "permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_positions" ADD CONSTRAINT "employee_positions_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_positions" ADD CONSTRAINT "employee_positions_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "positions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Стартовый справочник позиций (ТЗ 3.2). Сид одноразовый: дальше позициями
-- управляет администратор, и удалённая позиция не должна воскресать при
-- перезапуске. Исключение — `Director`: на него опирается правило доступа
-- к разделу Accounting, поэтому он системный и восстанавливается при старте.
INSERT INTO "positions" ("id", "name", "description", "isSystem", "createdAt", "updatedAt")
VALUES
    (gen_random_uuid(), 'Director',  'Руководитель центра: полный доступ, включая бухгалтерию', true,  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (gen_random_uuid(), 'Admin',     'Администратор системы',                                   false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (gen_random_uuid(), 'Manager',   'Менеджер: студенты, группы, лиды',                        false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (gen_random_uuid(), 'Mentor',    'Ментор: свои группы, журнал, материалы',                  false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (gen_random_uuid(), 'Developer', 'Разработчик',                                             false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("name") DO NOTHING;
