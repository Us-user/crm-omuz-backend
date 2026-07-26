-- Фаза 3: менторы группы (ТЗ 5.5).
--
--   group_mentors — назначение сотрудника ментором группы с ролью Teaching/Support.
--
-- Составной первичный ключ (groupId, employeeId): один сотрудник в группе
-- ровно один раз, две роли одновременно посчитали бы его часы дважды.
-- Индекс по employeeId — обратный обход «группы этого ментора» (ТЗ 5.4).
-- Связи каскадные: назначение — связь, а не самостоятельная запись.

-- CreateEnum
CREATE TYPE "GroupMentorRole" AS ENUM ('TEACHING', 'SUPPORT');

-- CreateTable
CREATE TABLE "group_mentors" (
    "groupId" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "role" "GroupMentorRole" NOT NULL DEFAULT 'TEACHING',
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "group_mentors_pkey" PRIMARY KEY ("groupId","employeeId")
);

-- CreateIndex
CREATE INDEX "group_mentors_employeeId_idx" ON "group_mentors"("employeeId");

-- AddForeignKey
ALTER TABLE "group_mentors" ADD CONSTRAINT "group_mentors_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_mentors" ADD CONSTRAINT "group_mentors_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;
