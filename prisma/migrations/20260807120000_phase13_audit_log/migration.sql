-- Фаза 13 — Аудит действий (ТЗ 3.6, 5.15 «Administration → Logs»).
--
-- Строка журнала: кто (ссылка на аккаунт + снимок имени, телефона и типа),
-- что (код действия), когда, над чем, с каким кодом ответа. Пишется
-- перехватчиком после изменяющего запроса; чтения в журнал не попадают.
--
-- SQL написан руками по формату Prisma (живой БД для `migrate diff` нет).

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "accountId" UUID,
    "actorName" TEXT,
    "actorPhone" TEXT,
    "actorType" "AccountType",
    "action" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "entityId" TEXT,
    "statusCode" INTEGER NOT NULL,
    "requestId" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_logs_createdAt_idx" ON "audit_logs"("createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_accountId_createdAt_idx" ON "audit_logs"("accountId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_action_createdAt_idx" ON "audit_logs"("action", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_entityId_idx" ON "audit_logs"("entityId");

-- AddForeignKey
-- `SET NULL`, а не `CASCADE`: удаление аккаунта не должно уносить историю его
-- действий. «Кто это был» после обнуления ссылки держит снимок в самой строке.
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
