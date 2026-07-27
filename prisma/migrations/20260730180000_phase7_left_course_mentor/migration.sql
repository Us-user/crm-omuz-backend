-- Фаза 7: ментор на момент ухода (ТЗ 5.12) и индекс под витрину покинувших.
--
-- `mentorAtLeaveId` — снимок, а не вычисляемое значение: ментора можно вывести
-- из состава менторов группы, но тогда смена преподавателя переписала бы отчёт
-- за прошлые месяцы задним числом. `SET NULL` — удаление профиля сотрудника
-- не повод стирать строку ухода: она про студента.
--
-- Индекс `(status, statusChangedAt)` — под `GET /left-courses`: витрина читает
-- уходы по всему центру за период, а не по одной группе.
--
-- Существующие строки колонку не заполняют: у уже закрытых членств ментора
-- на момент ухода никто не фиксировал, и подставлять сегодняшний состав
-- значило бы выдать догадку за снимок. Такие строки отдаются с `mentor: null`.

-- AlterTable
ALTER TABLE "group_students" ADD COLUMN     "mentorAtLeaveId" UUID;

-- CreateIndex
CREATE INDEX "group_students_status_statusChangedAt_idx" ON "group_students"("status", "statusChangedAt");

-- CreateIndex
CREATE INDEX "group_students_mentorAtLeaveId_idx" ON "group_students"("mentorAtLeaveId");

-- AddForeignKey
ALTER TABLE "group_students" ADD CONSTRAINT "group_students_mentorAtLeaveId_fkey" FOREIGN KEY ("mentorAtLeaveId") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;
