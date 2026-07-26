-- Фаза 1 — перевод Студент → Сотрудник (ТЗ 3.1).
-- Профиль студента при переводе сохраняется вместе с учебной историей, аккаунт
-- переезжает на профиль сотрудника, а связь с прошлым остаётся в `formerStudentId`.
-- Индекс уникален: один профиль студента переводится ровно один раз.

-- AlterTable
ALTER TABLE "employees" ADD COLUMN     "formerStudentId" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "employees_formerStudentId_key" ON "employees"("formerStudentId");

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_formerStudentId_fkey" FOREIGN KEY ("formerStudentId") REFERENCES "students"("id") ON DELETE SET NULL ON UPDATE CASCADE;
