-- Фаза 13 — Вакансии (ТЗ 5.18): ручной список актуальных вакансий.
--
-- Шесть полей ТЗ («название, описание, компания, требования, контакты, срок»)
-- плюс общий `DirectoryStatus`: место закрывают раньше объявленного срока чаще,
-- чем доводят до него. Уникальных ограничений нет ни на одном поле — одна
-- и та же вакансия законно повторяется у разных компаний и в разные сезоны.

-- CreateTable
CREATE TABLE "jobs" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "description" TEXT,
    "requirements" TEXT,
    "contacts" TEXT NOT NULL,
    "deadline" DATE,
    "status" "DirectoryStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "jobs_status_idx" ON "jobs"("status");

-- CreateIndex
CREATE INDEX "jobs_deadline_idx" ON "jobs"("deadline");
