import { PdfGeneratorService } from './pdf-generator.service';
import { DocxGeneratorService } from './docx-generator.service';

describe('Document Generators', () => {
  let pdfGenerator: PdfGeneratorService;
  let docxGenerator: DocxGeneratorService;

  beforeEach(() => {
    pdfGenerator = new PdfGeneratorService();
    docxGenerator = new DocxGeneratorService();
  });

  describe('PdfGeneratorService', () => {
    it('generates contract PDF buffer', async () => {
      const buffer = await pdfGenerator.generateContractPdf({
        contractNumber: 'ONT-2026-001',
        studentName: 'Каримова Нилуфар',
        studentPhone: '+992900000000',
        studentAddress: 'Душанбе, ул. Рудаки 10',
        courseTitle: 'Frontend Developer',
        issuedAt: new Date('2026-08-01'),
        validUntil: new Date('2027-08-01'),
        notes: 'Тестовый договор',
      });

      expect(Buffer.isBuffer(buffer)).toBe(true);
      expect(buffer.length).toBeGreaterThan(0);
    });

    it('generates certificate PDF buffer', async () => {
      const buffer = await pdfGenerator.generateCertificatePdf({
        serialNumber: 'CERT-2026-99',
        studentName: 'Каримова Нилуфар',
        courseTitle: 'Frontend Developer',
        issueDate: new Date('2026-08-01'),
        score: 92.5,
        activityCategory: 'Handsome',
      });

      expect(Buffer.isBuffer(buffer)).toBe(true);
      expect(buffer.length).toBeGreaterThan(0);
    });

    it('generates payment receipt PDF buffer', async () => {
      const buffer = await pdfGenerator.generatePaymentReceiptPdf({
        transactionId: '88888888-8888-8888-8888-888888888888',
        studentName: 'Каримова Нилуфар',
        studentPhone: '+992900000000',
        courseTitle: 'Frontend Developer',
        month: '2026-09',
        amountTjs: 600,
        paymentType: 'Cash',
        paidAt: new Date('2026-08-01'),
        note: 'Оплата первого месяца',
      });

      expect(Buffer.isBuffer(buffer)).toBe(true);
      expect(buffer.length).toBeGreaterThan(0);
    });

    it('generates accountant report PDF buffer', async () => {
      const buffer = await pdfGenerator.generateAccountantReportPdf({
        periodId: '11111111-1111-1111-1111-111111111111',
        periodName: 'III Квартал 2026',
        startDate: new Date('2026-07-01'),
        endDate: new Date('2026-09-30'),
        totalIncomeTjs: 15000,
        totalExpenseTjs: 5000,
        totalSalaryTjs: 4000,
        netProfitTjs: 6000,
        debtorAmountTjs: 2000,
      });

      expect(Buffer.isBuffer(buffer)).toBe(true);
      expect(buffer.length).toBeGreaterThan(0);
    });
  });

  describe('DocxGeneratorService', () => {
    it('generates contract DOCX buffer', async () => {
      const buffer = await docxGenerator.generateContractDocx({
        contractNumber: 'ONT-2026-001',
        studentName: 'Каримова Нилуфар',
        studentPhone: '+992900000000',
        issuedAt: new Date('2026-08-01'),
      });

      expect(Buffer.isBuffer(buffer)).toBe(true);
      expect(buffer.length).toBeGreaterThan(0);
    });

    it('generates payment receipt DOCX buffer', async () => {
      const buffer = await docxGenerator.generatePaymentReceiptDocx({
        transactionId: '88888888-8888-8888-8888-888888888888',
        studentName: 'Каримова Нилуфар',
        studentPhone: '+992900000000',
        amountTjs: 600,
        paymentType: 'Cash',
        paidAt: new Date('2026-08-01'),
      });

      expect(Buffer.isBuffer(buffer)).toBe(true);
      expect(buffer.length).toBeGreaterThan(0);
    });
  });
});
