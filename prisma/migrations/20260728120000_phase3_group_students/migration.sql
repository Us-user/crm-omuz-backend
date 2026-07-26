-- Состав группы (ТЗ 5.5: «состав студентов», ТЗ 5.12: «Left courses»).
--
-- Одна таблица `group_students` играет роль и `GroupStudent`, и `Enrollment`
-- из карты сущностей ТЗ 4: закрытые членства не удаляются, а остаются со своим
-- статусом, причиной и датой — вторая таблица «история зачислений» была бы
-- вторым источником истины о том же самом (решение сессии 0012).
--
-- Составной первичный ключ `(groupId, studentId)`: один студент в группе ровно
-- один раз. Правило «одно активное членство на курс» держит сервис — частичный
-- уникальный индекс Prisma не выражает.

-- CreateEnum
CREATE TYPE "GroupStudentStatus" AS ENUM ('ACTIVE', 'LEFT', 'FINISHED', 'TRANSFERRED');

-- CreateTable
CREATE TABLE "group_students" (
    "groupId" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "status" "GroupStudentStatus" NOT NULL DEFAULT 'ACTIVE',
    "statusReason" TEXT,
    "statusChangedAt" TIMESTAMP(3),
    "transferredFromGroupId" UUID,
    "enrolledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "group_students_pkey" PRIMARY KEY ("groupId","studentId")
);

-- CreateIndex
CREATE INDEX "group_students_studentId_idx" ON "group_students"("studentId");

-- CreateIndex
CREATE INDEX "group_students_groupId_status_idx" ON "group_students"("groupId", "status");

-- CreateIndex
CREATE INDEX "group_students_transferredFromGroupId_idx" ON "group_students"("transferredFromGroupId");

-- AddForeignKey
ALTER TABLE "group_students" ADD CONSTRAINT "group_students_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_students" ADD CONSTRAINT "group_students_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_students" ADD CONSTRAINT "group_students_transferredFromGroupId_fkey" FOREIGN KEY ("transferredFromGroupId") REFERENCES "groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;

