import { Injectable } from '@nestjs/common';
import PDFDocument from 'pdfkit';

export interface StudentContractData {
  contractNumber: string;
  studentName: string;
  studentPhone: string;
  studentAddress?: string;
  courseTitle?: string;
  issuedAt: Date;
  validUntil?: Date;
  notes?: string;
}

export interface GraduateCertificateData {
  serialNumber: string;
  studentName: string;
  courseTitle: string;
  issueDate: Date;
  score: number;
  activityCategory: string;
}

export interface PaymentReceiptData {
  transactionId: string;
  studentName: string;
  studentPhone: string;
  courseTitle?: string;
  month?: string;
  amountTjs: number;
  paymentType: string;
  paidAt: Date;
  note?: string;
}

export interface AccountantReportData {
  periodId: string;
  periodName: string;
  startDate: Date;
  endDate: Date;
  totalIncomeTjs: number;
  totalExpenseTjs: number;
  totalSalaryTjs: number;
  netProfitTjs: number;
  debtorAmountTjs: number;
}

@Injectable()
export class PdfGeneratorService {
  /**
   * Генерация PDF-документа договора студента.
   */
  async generateContractPdf(data: StudentContractData): Promise<Buffer> {
    return this.buildPdf((doc) => {
      // Header
      doc.fontSize(18).font('Helvetica-Bold').text('ДОГОВОР НА ОБУЧЕНИЕ', { align: 'center' });
      doc.fontSize(12).font('Helvetica-Bold').text(`№ ${data.contractNumber}`, { align: 'center' });
      doc.moveDown(1.5);

      // Organization info
      doc.fontSize(10).font('Helvetica').text(`Обучающий центр «Omuz»`);
      doc.text(`Дата выдачи: ${data.issuedAt.toISOString().split('T')[0]}`);
      if (data.validUntil) {
        doc.text(`Действителен до: ${data.validUntil.toISOString().split('T')[0]}`);
      }
      doc.moveDown(1);

      // Student info
      doc.fontSize(12).font('Helvetica-Bold').text('Сведения о студенте:');
      doc.fontSize(10).font('Helvetica').text(`ФИО: ${data.studentName}`);
      doc.text(`Телефон: ${data.studentPhone}`);
      if (data.studentAddress) {
        doc.text(`Адрес: ${data.studentAddress}`);
      }
      if (data.courseTitle) {
        doc.text(`Курс обучения: ${data.courseTitle}`);
      }
      doc.moveDown(1);

      // Terms
      doc.fontSize(12).font('Helvetica-Bold').text('Условия договора:');
      doc.fontSize(10).font('Helvetica').text(
        '1. Обучающий центр обязуется предоставить качественные образовательные услуги согласно утвержденной программе курса.',
      );
      doc.text(
        '2. Студент обязуется посещать занятия согласно расписанию и своевременно производить оплату.',
      );
      doc.text(
        '3. По окончании курса при успешной сдаче экзаменов студенту выдается сертификат установительного образца.',
      );

      if (data.notes) {
        doc.moveDown(1);
        doc.fontSize(10).font('Helvetica-Oblique').text(`Примечания: ${data.notes}`);
      }

      doc.moveDown(3);
      doc.fontSize(10).font('Helvetica').text('Подпись центра: ____________________          Подпись студента: ____________________');
    });
  }

  /**
   * Генерация PDF-сертификата выпускника.
   */
  async generateCertificatePdf(data: GraduateCertificateData): Promise<Buffer> {
    return this.buildPdf((doc) => {
      doc.rect(20, 20, doc.page.width - 40, doc.page.height - 40).stroke('#1D4ED8');
      doc.moveDown(2);

      doc.fontSize(24).font('Helvetica-Bold').fillColor('#1E3A8A').text('СЕРТИФИКАТ', { align: 'center' });
      doc.fontSize(12).font('Helvetica').fillColor('#4B5563').text(`Серия ${data.serialNumber}`, { align: 'center' });
      doc.moveDown(2);

      doc.fontSize(14).font('Helvetica').fillColor('#111827').text('Настоящий сертификат подтверждает, что', { align: 'center' });
      doc.moveDown(0.5);

      doc.fontSize(20).font('Helvetica-Bold').fillColor('#1D4ED8').text(data.studentName, { align: 'center' });
      doc.moveDown(0.5);

      doc.fontSize(14).font('Helvetica').fillColor('#111827').text(`успешно прошел(ла) обучение по курсу`, { align: 'center' });
      doc.fontSize(16).font('Helvetica-Bold').fillColor('#111827').text(data.courseTitle, { align: 'center' });
      doc.moveDown(1.5);

      doc.fontSize(11).font('Helvetica').fillColor('#374151').text(`Средний балл: ${data.score} (${data.activityCategory})`, { align: 'center' });
      doc.text(`Дата выдачи: ${data.issueDate.toISOString().split('T')[0]}`, { align: 'center' });
      doc.moveDown(3);

      doc.fontSize(10).font('Helvetica').fillColor('#6B7280').text('Директор обучающего центра «Omuz» ____________________', { align: 'center' });
    });
  }

  /**
   * Генерация PDF-квитанции (чека) оплаты.
   */
  async generatePaymentReceiptPdf(data: PaymentReceiptData): Promise<Buffer> {
    return this.buildPdf((doc) => {
      doc.fontSize(16).font('Helvetica-Bold').text('КВИТАНЦИЯ ОБ ОПЛАТЕ', { align: 'center' });
      doc.fontSize(10).font('Helvetica').text(`Транзакция №: ${data.transactionId}`, { align: 'center' });
      doc.moveDown(1.5);

      doc.fontSize(10).font('Helvetica').text(`Обучающий центр «Omuz»`);
      doc.text(`Дата и время: ${data.paidAt.toISOString()}`);
      doc.moveDown(1);

      doc.fontSize(11).font('Helvetica-Bold').text('Плательщик:');
      doc.fontSize(10).font('Helvetica').text(`ФИО: ${data.studentName}`);
      doc.text(`Телефон: ${data.studentPhone}`);
      if (data.courseTitle) {
        doc.text(`Курс: ${data.courseTitle}`);
      }
      if (data.month) {
        doc.text(`Месяц обучения: ${data.month}`);
      }
      doc.moveDown(1);

      doc.fontSize(11).font('Helvetica-Bold').text('Детали платежа:');
      doc.fontSize(10).font('Helvetica').text(`Способ оплаты: ${data.paymentType}`);
      doc.fontSize(12).font('Helvetica-Bold').text(`Сумма оплаты: ${data.amountTjs.toFixed(2)} TJS`);

      if (data.note) {
        doc.moveDown(0.5);
        doc.fontSize(9).font('Helvetica-Oblique').text(`Примечание: ${data.note}`);
      }

      doc.moveDown(2);
      doc.fontSize(9).font('Helvetica').text('Кассир / Бухгалтер: ____________________');
    });
  }

  /**
   * Генерация PDF-отчёта бухгалтера.
   */
  async generateAccountantReportPdf(data: AccountantReportData): Promise<Buffer> {
    return this.buildPdf((doc) => {
      doc.fontSize(18).font('Helvetica-Bold').text('ФИНАНСОВЫЙ ОТЧЁТ', { align: 'center' });
      doc.fontSize(12).font('Helvetica').text(`Период: ${data.periodName}`, { align: 'center' });
      doc.moveDown(1.5);

      doc.fontSize(10).font('Helvetica').text(`Дата формирования: ${new Date().toISOString().split('T')[0]}`);
      doc.text(`Даты периода: ${data.startDate.toISOString().split('T')[0]} - ${data.endDate.toISOString().split('T')[0]}`);
      doc.moveDown(1.5);

      doc.fontSize(12).font('Helvetica-Bold').text('Сводные финансовые показатели:');
      doc.moveDown(0.5);

      doc.fontSize(10).font('Helvetica').text(`Общий доход (Income): ${data.totalIncomeTjs.toFixed(2)} TJS`);
      doc.text(`Общие расходы (Expenses): ${data.totalExpenseTjs.toFixed(2)} TJS`);
      doc.text(`Фонд оплаты труда (Salaries): ${data.totalSalaryTjs.toFixed(2)} TJS`);
      doc.fontSize(11).font('Helvetica-Bold').text(`Чистый финансовый результат (Net): ${data.netProfitTjs.toFixed(2)} TJS`);
      doc.text(`Задолженность студентов (Debts): ${data.debtorAmountTjs.toFixed(2)} TJS`);

      doc.moveDown(3);
      doc.fontSize(10).font('Helvetica').text('Главный бухгалтер: ____________________        Директор: ____________________');
    });
  }

  private buildPdf(buildFn: (doc: PDFKit.PDFDocument) => void): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const chunks: Buffer[] = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', (err) => reject(err));
      buildFn(doc);
      doc.end();
    });
  }
}
