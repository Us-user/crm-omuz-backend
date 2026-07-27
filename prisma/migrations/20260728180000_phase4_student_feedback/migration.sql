-- Фаза 4 (ТЗ 5.3): обратная связь по студенту.
--
-- Заметка сотрудника о студенте — то, что показывает карточка рядом с Edit /
-- Block / Delete. Приглашение (Invite) и блокировка (Block) своих таблиц
-- не заводят: первое создаёт обычный `accounts`, вторая переводит
-- `accounts.status` и `students.status`.
--
-- Каскад со стороны студента: заметка вне студента ничего не значит.
-- `SET NULL` со стороны автора: уход сотрудника не повод стирать наблюдения.

-- CreateTable
CREATE TABLE "student_feedback" (
    "id" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "authorId" UUID,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "student_feedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "student_feedback_studentId_createdAt_idx" ON "student_feedback"("studentId", "createdAt");

-- CreateIndex
CREATE INDEX "student_feedback_authorId_idx" ON "student_feedback"("authorId");

-- AddForeignKey
ALTER TABLE "student_feedback" ADD CONSTRAINT "student_feedback_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_feedback" ADD CONSTRAINT "student_feedback_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

