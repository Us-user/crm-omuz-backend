-- Фаза 3: расписание группы (ТЗ 5.5, 5.10).
--
--   schedule_slots — слот занятия: день недели + время + аудитория + ментор.
--
-- Слот повторяется еженедельно в пределах сроков группы, поэтому дня недели
-- достаточно: календарь Day/Week/Month разворачивает слоты в даты на лету.
-- Время хранится минутами от полуночи (0…1439) — целое число сравнимо
-- и сортируемо без разбора часовых поясов; наружу уходит «HH:MM».
--
-- Связи: группа — CASCADE (слот вне группы адресовать нечем), аудитория —
-- RESTRICT (справочная запись, её удаление не должно стирать занятия),
-- ментор — SET NULL (занятие остаётся, даже если вести его стало некому).

-- CreateEnum
CREATE TYPE "WeekDay" AS ENUM ('MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY');

-- CreateTable
CREATE TABLE "schedule_slots" (
    "id" UUID NOT NULL,
    "groupId" UUID NOT NULL,
    "dayOfWeek" "WeekDay" NOT NULL,
    "startMinute" INTEGER NOT NULL,
    "endMinute" INTEGER NOT NULL,
    "roomId" UUID,
    "mentorId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "schedule_slots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "schedule_slots_groupId_dayOfWeek_startMinute_idx" ON "schedule_slots"("groupId", "dayOfWeek", "startMinute");

-- CreateIndex
CREATE INDEX "schedule_slots_roomId_dayOfWeek_idx" ON "schedule_slots"("roomId", "dayOfWeek");

-- CreateIndex
CREATE INDEX "schedule_slots_mentorId_dayOfWeek_idx" ON "schedule_slots"("mentorId", "dayOfWeek");

-- AddForeignKey
ALTER TABLE "schedule_slots" ADD CONSTRAINT "schedule_slots_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_slots" ADD CONSTRAINT "schedule_slots_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "rooms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_slots" ADD CONSTRAINT "schedule_slots_mentorId_fkey" FOREIGN KEY ("mentorId") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

