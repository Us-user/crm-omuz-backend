import { MailingAudience, MessageChannel, NotificationStatus } from '@prisma/client';

import {
  addressFor,
  audienceNeedsGroup,
  countDeliveries,
  EMPTY_DELIVERY_COUNTS,
  MAX_MAILING_RECIPIENTS,
  MailingStatus,
  mailingStatusOf,
  personalBodyOf,
  recipientNameOf,
  recipientTypeOf,
  renderMessage,
} from './mailings';

const counts = (
  over: Partial<typeof EMPTY_DELIVERY_COUNTS> = {},
): typeof EMPTY_DELIVERY_COUNTS => ({
  ...EMPTY_DELIVERY_COUNTS,
  ...over,
});

describe('countDeliveries', () => {
  it('раскладывает группы по четырём состояниям и считает общее число', () => {
    expect(
      countDeliveries([
        { status: NotificationStatus.SENT, count: 12 },
        { status: NotificationStatus.PENDING, count: 3 },
        { status: NotificationStatus.FAILED, count: 2 },
        { status: NotificationStatus.SKIPPED, count: 1 },
      ]),
    ).toEqual({ total: 18, pending: 3, sent: 12, failed: 2, skipped: 1 });
  });

  it('на пустом наборе даёт нули, а не отсутствующие поля', () => {
    expect(countDeliveries([])).toEqual(EMPTY_DELIVERY_COUNTS);
  });

  it('складывает строки одного состояния', () => {
    expect(
      countDeliveries([
        { status: NotificationStatus.SENT, count: 4 },
        { status: NotificationStatus.SENT, count: 6 },
      ]),
    ).toMatchObject({ sent: 10, total: 10 });
  });

  it('не зависит от порядка групп', () => {
    const forward = countDeliveries([
      { status: NotificationStatus.FAILED, count: 2 },
      { status: NotificationStatus.SENT, count: 5 },
    ]);
    const backward = countDeliveries([
      { status: NotificationStatus.SENT, count: 5 },
      { status: NotificationStatus.FAILED, count: 2 },
    ]);

    expect(forward).toEqual(backward);
  });

  it('не трогает общий образец нулевых счётчиков', () => {
    countDeliveries([{ status: NotificationStatus.SENT, count: 3 }]);

    expect(EMPTY_DELIVERY_COUNTS).toEqual({
      total: 0,
      pending: 0,
      sent: 0,
      failed: 0,
      skipped: 0,
    });
  });
});

describe('mailingStatusOf', () => {
  it('без даты отправки это черновик, счётчики не смотрятся вовсе', () => {
    expect(mailingStatusOf(null, counts({ total: 10, sent: 10 }))).toBe(MailingStatus.DRAFT);
  });

  it('пока есть незавершённые доставки — отправка идёт', () => {
    expect(mailingStatusOf(new Date(), counts({ total: 10, sent: 8, pending: 2 }))).toBe(
      MailingStatus.SENDING,
    );
  });

  it('незавершённая доставка перевешивает упавшие', () => {
    expect(mailingStatusOf(new Date(), counts({ total: 3, pending: 1, failed: 2 }))).toBe(
      MailingStatus.SENDING,
    );
  });

  it('доставлено всем — SENT', () => {
    expect(mailingStatusOf(new Date(), counts({ total: 7, sent: 7 }))).toBe(MailingStatus.SENT);
  });

  it('часть не дошла — PARTIAL', () => {
    expect(mailingStatusOf(new Date(), counts({ total: 7, sent: 5, failed: 2 }))).toBe(
      MailingStatus.PARTIAL,
    );
  });

  it('пропущенные из-за отсутствия адреса тоже делают рассылку частичной', () => {
    expect(mailingStatusOf(new Date(), counts({ total: 7, sent: 6, skipped: 1 }))).toBe(
      MailingStatus.PARTIAL,
    );
  });

  it('не ушло никому — FAILED', () => {
    expect(mailingStatusOf(new Date(), counts({ total: 4, failed: 4 }))).toBe(MailingStatus.FAILED);
  });

  it('рассылка, у всех получателей которой не нашлось адреса, не «отправлена»', () => {
    expect(mailingStatusOf(new Date(), counts({ total: 4, skipped: 4 }))).toBe(
      MailingStatus.FAILED,
    );
  });
});

describe('addressFor', () => {
  const contacts = { telegram: '@umed', phone: '+992900000001', email: 'umed@omuz.tj' };

  it('берёт telegram, телефон или почту — по каналу', () => {
    expect(addressFor(MessageChannel.TELEGRAM, contacts)).toBe('@umed');
    expect(addressFor(MessageChannel.SMS, contacts)).toBe('+992900000001');
    expect(addressFor(MessageChannel.EMAIL, contacts)).toBe('umed@omuz.tj');
  });

  it('пустого контакта нет — это null, а не пустая строка', () => {
    expect(addressFor(MessageChannel.TELEGRAM, { ...contacts, telegram: null })).toBeNull();
  });

  it('строка из пробелов адресом не является', () => {
    expect(addressFor(MessageChannel.TELEGRAM, { ...contacts, telegram: '   ' })).toBeNull();
  });

  it('пустая строка адресом не является', () => {
    expect(addressFor(MessageChannel.SMS, { ...contacts, phone: '' })).toBeNull();
  });

  it('пробелы по краям обрезаются', () => {
    expect(addressFor(MessageChannel.EMAIL, { ...contacts, email: '  a@b.tj ' })).toBe('a@b.tj');
  });

  it('отсутствие одного контакта не влияет на другой канал', () => {
    expect(addressFor(MessageChannel.SMS, { ...contacts, telegram: null })).toBe('+992900000001');
  });
});

describe('recipientTypeOf', () => {
  it('менторам пишут как сотрудникам', () => {
    expect(recipientTypeOf(MailingAudience.MENTORS)).toBe('EMPLOYEE');
  });

  it('лидам — как обращениям', () => {
    expect(recipientTypeOf(MailingAudience.LEADS)).toBe('LEAD');
  });

  it('группа, студенты и выпускники адресуются профилю студента', () => {
    expect(recipientTypeOf(MailingAudience.GROUP)).toBe('STUDENT');
    expect(recipientTypeOf(MailingAudience.STUDENTS)).toBe('STUDENT');
    // Выпускник — тот же профиль с записью о выпуске (0026), а не другой человек.
    expect(recipientTypeOf(MailingAudience.GRADUATES)).toBe('STUDENT');
  });
});

describe('audienceNeedsGroup', () => {
  it('группа нужна только аудитории GROUP', () => {
    expect(audienceNeedsGroup(MailingAudience.GROUP)).toBe(true);

    for (const audience of [
      MailingAudience.STUDENTS,
      MailingAudience.MENTORS,
      MailingAudience.LEADS,
      MailingAudience.GRADUATES,
    ]) {
      expect(audienceNeedsGroup(audience)).toBe(false);
    }
  });
});

describe('recipientNameOf', () => {
  it('склеивает имя и фамилию', () => {
    expect(recipientNameOf('Умед', 'Раҳимов')).toBe('Умед Раҳимов');
  });

  it('не оставляет висящего пробела, если одна из частей пуста', () => {
    expect(recipientNameOf('Умед', '')).toBe('Умед');
  });
});

describe('MAX_MAILING_RECIPIENTS', () => {
  it('совпадает с потолком выгрузки лидов (0028)', () => {
    expect(MAX_MAILING_RECIPIENTS).toBe(5000);
  });
});

describe('renderMessage (подстановка переменных)', () => {
  const vars = { firstName: 'Умед', lastName: 'Каримов' };

  it('подставляет firstName, lastName и fullName', () => {
    expect(renderMessage('Привет, {{firstName}}!', vars)).toBe('Привет, Умед!');
    expect(renderMessage('{{lastName}} {{firstName}}', vars)).toBe('Каримов Умед');
    expect(renderMessage('{{fullName}}', vars)).toBe('Умед Каримов');
  });

  it('терпит пробелы внутри скобок', () => {
    expect(renderMessage('С ДР, {{ firstName }}!', vars)).toBe('С ДР, Умед!');
  });

  it('несколько вхождений одной переменной', () => {
    expect(renderMessage('{{firstName}}, {{firstName}}!', vars)).toBe('Умед, Умед!');
  });

  it('неизвестный плейсхолдер остаётся как есть', () => {
    expect(renderMessage('Привет, {{firstname}}!', vars)).toBe('Привет, {{firstname}}!');
  });

  it('текст без плейсхолдеров не меняется', () => {
    expect(renderMessage('Общее объявление', vars)).toBe('Общее объявление');
  });
});

describe('personalBodyOf', () => {
  const vars = { firstName: 'Умед', lastName: 'Каримов' };

  it('null, когда подставлять нечего (текст дословно равен исходному)', () => {
    expect(personalBodyOf('Общее объявление', vars)).toBeNull();
    // Неизвестный плейсхолдер тоже не меняет текст — копию не заводим.
    expect(personalBodyOf('Привет, {{unknown}}', vars)).toBeNull();
  });

  it('персональную копию, когда подстановка была', () => {
    expect(personalBodyOf('С ДР, {{firstName}}!', vars)).toBe('С ДР, Умед!');
  });
});
