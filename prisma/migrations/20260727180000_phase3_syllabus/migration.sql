-- Фаза 3: силлабус курса (ТЗ 5.6).
--
--   syllabus_lessons       — уроки программы («Day N»), тип Lecture/Practice/Exam;
--   syllabus_lesson_groups — «Show to group»: каким группам урок показан;
--   resource_files         — материалы урока (ссылки на внешнее хранилище).
--
-- Все связи каскадные: урок вне курса и файл вне урока адресовать нечем,
-- а видимость удалённой группы восстанавливать незачем.

-- CreateEnum
CREATE TYPE "LessonType" AS ENUM ('LECTURE', 'PRACTICE', 'EXAM');

-- CreateEnum
CREATE TYPE "ResourceKind" AS ENUM ('LECTURE', 'PRACTICE', 'HOMEWORK');

-- CreateEnum
CREATE TYPE "ResourceFileType" AS ENUM ('PDF', 'DOC', 'SLIDES', 'SPREADSHEET', 'IMAGE', 'VIDEO', 'AUDIO', 'ARCHIVE', 'LINK', 'OTHER');

-- CreateTable
CREATE TABLE "syllabus_lessons" (
    "id" UUID NOT NULL,
    "courseId" UUID NOT NULL,
    "dayNumber" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "type" "LessonType" NOT NULL DEFAULT 'LECTURE',
    "status" "DirectoryStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "syllabus_lessons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "syllabus_lesson_groups" (
    "lessonId" UUID NOT NULL,
    "groupId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "syllabus_lesson_groups_pkey" PRIMARY KEY ("lessonId","groupId")
);

-- CreateTable
CREATE TABLE "resource_files" (
    "id" UUID NOT NULL,
    "lessonId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "kind" "ResourceKind" NOT NULL DEFAULT 'LECTURE',
    "fileType" "ResourceFileType" NOT NULL DEFAULT 'OTHER',
    "url" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "resource_files_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "syllabus_lessons_courseId_dayNumber_idx" ON "syllabus_lessons"("courseId", "dayNumber");

-- CreateIndex
CREATE INDEX "syllabus_lesson_groups_groupId_idx" ON "syllabus_lesson_groups"("groupId");

-- CreateIndex
CREATE INDEX "resource_files_lessonId_idx" ON "resource_files"("lessonId");

-- AddForeignKey
ALTER TABLE "syllabus_lessons" ADD CONSTRAINT "syllabus_lessons_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "syllabus_lesson_groups" ADD CONSTRAINT "syllabus_lesson_groups_lessonId_fkey" FOREIGN KEY ("lessonId") REFERENCES "syllabus_lessons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "syllabus_lesson_groups" ADD CONSTRAINT "syllabus_lesson_groups_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resource_files" ADD CONSTRAINT "resource_files_lessonId_fkey" FOREIGN KEY ("lessonId") REFERENCES "syllabus_lessons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

