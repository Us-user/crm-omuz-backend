-- AlterEnum
-- Системная рассылка (поздравления с ДР, ТЗ 3.4): аудитория, которую нельзя
-- выбрать в форме — получателей вычисляет фоновая задача.
ALTER TYPE "MailingAudience" ADD VALUE 'SYSTEM';

-- AlterTable
-- Ключ идемпотентности системной рассылки (`birthday:2026-08-03`). У рассылки,
-- составленной человеком, остаётся NULL.
ALTER TABLE "mailings" ADD COLUMN     "systemKey" TEXT;

-- AlterTable
-- Персональный текст доставки после подстановки переменных; NULL, когда он
-- совпадает с общим текстом рассылки (обработчик берёт `body ?? mailing.body`).
ALTER TABLE "notifications" ADD COLUMN     "body" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "mailings_systemKey_key" ON "mailings"("systemKey");
