-- CreateEnum
CREATE TYPE "MessageChannel" AS ENUM ('TELEGRAM', 'SMS', 'EMAIL');

-- CreateEnum
CREATE TYPE "MailingAudience" AS ENUM ('GROUP', 'STUDENTS', 'MENTORS', 'LEADS', 'GRADUATES');

-- CreateEnum
CREATE TYPE "NotificationRecipientType" AS ENUM ('STUDENT', 'EMPLOYEE', 'LEAD');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'SKIPPED');

-- AlterTable
ALTER TABLE "leads" ADD COLUMN     "telegram" TEXT;

-- CreateTable
CREATE TABLE "sms_templates" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "channel" "MessageChannel",
    "status" "DirectoryStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sms_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mailings" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "channel" "MessageChannel" NOT NULL,
    "audience" "MailingAudience" NOT NULL,
    "groupId" UUID,
    "templateId" UUID,
    "sentAt" TIMESTAMP(3),
    "sentById" UUID,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mailings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "mailingId" UUID NOT NULL,
    "channel" "MessageChannel" NOT NULL,
    "recipientType" "NotificationRecipientType" NOT NULL,
    "recipientName" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "studentId" UUID,
    "employeeId" UUID,
    "leadId" UUID,
    "status" "NotificationStatus" NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sms_templates_name_key" ON "sms_templates"("name");

-- CreateIndex
CREATE INDEX "sms_templates_status_name_idx" ON "sms_templates"("status", "name");

-- CreateIndex
CREATE INDEX "mailings_createdAt_idx" ON "mailings"("createdAt");

-- CreateIndex
CREATE INDEX "mailings_sentAt_idx" ON "mailings"("sentAt");

-- CreateIndex
CREATE INDEX "mailings_audience_idx" ON "mailings"("audience");

-- CreateIndex
CREATE INDEX "mailings_groupId_idx" ON "mailings"("groupId");

-- CreateIndex
CREATE INDEX "mailings_templateId_idx" ON "mailings"("templateId");

-- CreateIndex
CREATE INDEX "notifications_mailingId_status_idx" ON "notifications"("mailingId", "status");

-- CreateIndex
CREATE INDEX "notifications_studentId_idx" ON "notifications"("studentId");

-- CreateIndex
CREATE INDEX "notifications_employeeId_idx" ON "notifications"("employeeId");

-- CreateIndex
CREATE INDEX "notifications_leadId_idx" ON "notifications"("leadId");

-- AddForeignKey
ALTER TABLE "sms_templates" ADD CONSTRAINT "sms_templates_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mailings" ADD CONSTRAINT "mailings_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mailings" ADD CONSTRAINT "mailings_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "sms_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mailings" ADD CONSTRAINT "mailings_sentById_fkey" FOREIGN KEY ("sentById") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mailings" ADD CONSTRAINT "mailings_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_mailingId_fkey" FOREIGN KEY ("mailingId") REFERENCES "mailings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

