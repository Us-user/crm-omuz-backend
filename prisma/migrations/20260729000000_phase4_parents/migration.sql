-- Фаза 4 (ТЗ 4: Parent/Guardian): родители и опекуны студента.
--
-- Запись родителя общая, а не принадлежащая студенту: у одного родителя бывает
-- несколько детей в центре. Узнаётся по телефону — он и есть естественный ключ
-- (`parents_phone_key`), поэтому второй ребёнок привязывается к уже заведённой
-- записи, а не заводит её копию.
--
-- Степень родства (`relation`) лежит на связке, а не в самой записи: один
-- человек бывает матерью одному ребёнку и опекуном другому. Она необязательна —
-- регистрация (ТЗ 3.1) собирает только номер.
--
-- Колонка `students.parentPhone` убирается: с появлением `parents` она стала бы
-- вторым источником истины о том же контакте. Порядок операций здесь отличается
-- от вывода `prisma migrate diff` намеренно — таблицы создаются и наполняются
-- ДО удаления колонки, иначе перенос был бы невозможен.

-- CreateEnum
CREATE TYPE "ParentRelation" AS ENUM ('MOTHER', 'FATHER', 'GUARDIAN', 'OTHER');

-- CreateTable
CREATE TABLE "parents" (
    "id" UUID NOT NULL,
    "firstName" TEXT,
    "lastName" TEXT,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "telegram" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "parents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_parents" (
    "studentId" UUID NOT NULL,
    "parentId" UUID NOT NULL,
    "relation" "ParentRelation",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "student_parents_pkey" PRIMARY KEY ("studentId","parentId")
);

-- CreateIndex
CREATE UNIQUE INDEX "parents_phone_key" ON "parents"("phone");

-- CreateIndex
CREATE INDEX "student_parents_parentId_idx" ON "student_parents"("parentId");

-- AddForeignKey
ALTER TABLE "student_parents" ADD CONSTRAINT "student_parents_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_parents" ADD CONSTRAINT "student_parents_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "parents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- MigrateData: перенос `students.parentPhone` в записи родителей.
-- Номера в колонке уже нормализованы в E.164 (ТЗ 3.1), поэтому `GROUP BY`
-- сводит родителя двух детей в одну запись — ровно то, ради чего заводится
-- общая таблица. Имя и степень родства остаются пустыми: при регистрации
-- их никто не спрашивал, и любое подставленное значение было бы выдумкой.
INSERT INTO "parents" ("id", "phone", "createdAt", "updatedAt")
SELECT gen_random_uuid(), s."parentPhone", NOW(), NOW()
FROM "students" s
WHERE s."parentPhone" IS NOT NULL AND btrim(s."parentPhone") <> ''
GROUP BY s."parentPhone";

INSERT INTO "student_parents" ("studentId", "parentId", "createdAt")
SELECT s."id", p."id", NOW()
FROM "students" s
JOIN "parents" p ON p."phone" = s."parentPhone"
WHERE s."parentPhone" IS NOT NULL AND btrim(s."parentPhone") <> '';

-- AlterTable
ALTER TABLE "students" DROP COLUMN "parentPhone";
