import { Injectable } from '@nestjs/common';
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  AlignmentType,
  HeadingLevel,
} from 'docx';
import { StudentContractData, PaymentReceiptData } from './pdf-generator.service';

@Injectable()
export class DocxGeneratorService {
  /**
   * Генерация DOCX-документа договора студента.
   */
  async generateContractDocx(data: StudentContractData): Promise<Buffer> {
    const doc = new Document({
      sections: [
        {
          children: [
            new Paragraph({
              text: 'ДОГОВОР НА ОБУЧЕНИЕ',
              heading: HeadingLevel.HEADING_1,
              alignment: AlignmentType.CENTER,
            }),
            new Paragraph({
              text: `№ ${data.contractNumber}`,
              alignment: AlignmentType.CENTER,
            }),
            new Paragraph({ text: '' }),
            new Paragraph({
              children: [
                new TextRun({ text: 'Обучающий центр «Omuz»', bold: true }),
              ],
            }),
            new Paragraph({
              text: `Дата выдачи: ${data.issuedAt.toISOString().split('T')[0]}`,
            }),
            data.validUntil
              ? new Paragraph({
                  text: `Действителен до: ${data.validUntil.toISOString().split('T')[0]}`,
                })
              : new Paragraph({ text: '' }),
            new Paragraph({ text: '' }),
            new Paragraph({
              children: [
                new TextRun({ text: 'Сведения о студенте:', bold: true }),
              ],
            }),
            new Paragraph({ text: `ФИО: ${data.studentName}` }),
            new Paragraph({ text: `Телефон: ${data.studentPhone}` }),
            data.studentAddress
              ? new Paragraph({ text: `Адрес: ${data.studentAddress}` })
              : new Paragraph({ text: '' }),
            data.courseTitle
              ? new Paragraph({ text: `Курс обучения: ${data.courseTitle}` })
              : new Paragraph({ text: '' }),
            new Paragraph({ text: '' }),
            new Paragraph({
              children: [
                new TextRun({ text: 'Условия договора:', bold: true }),
              ],
            }),
            new Paragraph({
              text: '1. Обучающий центр обязуется предоставить качественные образовательные услуги согласно утвержденной программе курса.',
            }),
            new Paragraph({
              text: '2. Студент обязуется посещать занятия согласно расписанию и своевременно производить оплату.',
            }),
            new Paragraph({
              text: '3. По окончании курса при успешной сдаче экзаменов студенту выдается сертификат установительного образца.',
            }),
            data.notes
              ? new Paragraph({ children: [new TextRun({ text: `Примечания: ${data.notes}`, italics: true })] })
              : new Paragraph({ text: '' }),
            new Paragraph({ text: '' }),
            new Paragraph({ text: '' }),
            new Paragraph({
              text: 'Подпись центра: ____________________          Подпись студента: ____________________',
            }),
          ],
        },
      ],
    });

    return await Packer.toBuffer(doc);
  }

  /**
   * Генерация DOCX-квитанции (чека) оплаты.
   */
  async generatePaymentReceiptDocx(data: PaymentReceiptData): Promise<Buffer> {
    const doc = new Document({
      sections: [
        {
          children: [
            new Paragraph({
              text: 'КВИТАНЦИЯ ОБ ОПЛАТЕ',
              heading: HeadingLevel.HEADING_1,
              alignment: AlignmentType.CENTER,
            }),
            new Paragraph({
              text: `Транзакция №: ${data.transactionId}`,
              alignment: AlignmentType.CENTER,
            }),
            new Paragraph({ text: '' }),
            new Paragraph({
              children: [
                new TextRun({ text: 'Обучающий центр «Omuz»', bold: true }),
              ],
            }),
            new Paragraph({ text: `Дата и время: ${data.paidAt.toISOString()}` }),
            new Paragraph({ text: '' }),
            new Paragraph({
              children: [
                new TextRun({ text: 'Плательщик:', bold: true }),
              ],
            }),
            new Paragraph({ text: `ФИО: ${data.studentName}` }),
            new Paragraph({ text: `Телефон: ${data.studentPhone}` }),
            data.courseTitle
              ? new Paragraph({ text: `Курс: ${data.courseTitle}` })
              : new Paragraph({ text: '' }),
            data.month
              ? new Paragraph({ text: `Месяц обучения: ${data.month}` })
              : new Paragraph({ text: '' }),
            new Paragraph({ text: '' }),
            new Paragraph({
              children: [
                new TextRun({ text: 'Детали платежа:', bold: true }),
              ],
            }),
            new Paragraph({ text: `Способ оплаты: ${data.paymentType}` }),
            new Paragraph({
              children: [
                new TextRun({
                  text: `Сумма оплаты: ${data.amountTjs.toFixed(2)} TJS`,
                  bold: true,
                }),
              ],
            }),
            data.note
              ? new Paragraph({ children: [new TextRun({ text: `Примечание: ${data.note}`, italics: true })] })
              : new Paragraph({ text: '' }),
            new Paragraph({ text: '' }),
            new Paragraph({
              text: 'Кассир / Бухгалтер: ____________________',
            }),
          ],
        },
      ],
    });

    return await Packer.toBuffer(doc);
  }
}
