import { Gender, LeadType } from '@prisma/client';

import { LEADS_CSV_HEADER, toCsvRow } from './leads.csv';
import type { LeadRow } from './leads.repository';

const day = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

const row = (overrides: Partial<LeadRow> = {}): LeadRow => ({
  id: '11111111-1111-1111-1111-111111111111',
  firstName: 'Нигина',
  lastName: 'Каримова',
  phone: '+992901234567',
  email: null,
  birthDate: null,
  gender: null,
  occupation: null,
  enrollMonth: null,
  lessonTimeMinute: null,
  notes: null,
  source: null,
  utmSource: null,
  utmMedium: null,
  utmCampaign: null,
  type: LeadType.LEAD,
  becameClientAt: null,
  convertedStudentId: null,
  convertedAt: null,
  createdAt: new Date('2026-08-15T10:23:45.000Z'),
  course: null,
  coupon: null,
  branch: null,
  ...overrides,
});

/** Позиция колонки по её названию — тест не должен считать запятые руками. */
const at = (values: string[], column: (typeof LEADS_CSV_HEADER)[number]): string =>
  values[LEADS_CSV_HEADER.indexOf(column)];

describe('Выгрузка лидов в CSV (ТЗ 5.7: «Export»)', () => {
  it('строка ровно той же длины, что заголовок', () => {
    expect(toCsvRow(row())).toHaveLength(LEADS_CSV_HEADER.length);
  });

  it('телефон стоит первой колонкой — по нему человека узнают в таблице', () => {
    expect(LEADS_CSV_HEADER[0]).toBe('Телефон');
    expect(toCsvRow(row())[0]).toBe('+992901234567');
  });

  it('стадия и пол выгружаются словами, а не кодами enum', () => {
    const values = toCsvRow(row({ type: LeadType.CLIENT, gender: Gender.FEMALE }));

    expect(at(values, 'Стадия')).toBe('Клиент');
    expect(at(values, 'Пол')).toBe('Женский');
  });

  it('лид остаётся «Лид», мужской пол — «Мужской»', () => {
    const values = toCsvRow(row({ gender: Gender.MALE }));

    expect(at(values, 'Стадия')).toBe('Лид');
    expect(at(values, 'Пол')).toBe('Мужской');
  });

  it('даты выгружаются днём без времени, месяц записи — как `YYYY-MM`', () => {
    const values = toCsvRow(
      row({
        birthDate: day('2004-05-17'),
        enrollMonth: day('2026-09-01'),
        becameClientAt: new Date('2026-08-20T12:34:56.000Z'),
      }),
    );

    expect(at(values, 'Дата рождения')).toBe('2004-05-17');
    expect(at(values, 'Месяц записи')).toBe('2026-09');
    expect(at(values, 'Дата перехода в клиенты')).toBe('2026-08-20');
    expect(at(values, 'Дата обращения')).toBe('2026-08-15');
  });

  it('время урока выгружается как `HH:MM`, а не минутами', () => {
    expect(at(toCsvRow(row({ lessonTimeMinute: 18 * 60 + 30 })), 'Время урока')).toBe('18:30');
  });

  it('ссылки выгружаются названиями: курс, филиал и купон', () => {
    const values = toCsvRow(
      row({
        course: { id: 'c', title: 'Frontend' },
        branch: { id: 'b', name: 'Sadbarg' },
        coupon: { id: 'k', name: 'OSEN-2026' },
      }),
    );

    expect(at(values, 'Курс')).toBe('Frontend');
    expect(at(values, 'Филиал')).toBe('Sadbarg');
    expect(at(values, 'Купон')).toBe('OSEN-2026');
  });

  it('незаполненные поля становятся пустыми ячейками, а не строкой «null»', () => {
    const values = toCsvRow(row());

    expect(at(values, 'Email')).toBe('');
    expect(at(values, 'Дата рождения')).toBe('');
    expect(at(values, 'Пол')).toBe('');
    expect(at(values, 'Курс')).toBe('');
    expect(at(values, 'Время урока')).toBe('');
    expect(at(values, 'Дата перевода')).toBe('');
  });

  it('«переведён» выводится из ссылки на профиль, а не из отдельного флага', () => {
    expect(at(toCsvRow(row()), 'Переведён в студенты')).toBe('Нет');

    const converted = toCsvRow(
      row({ convertedStudentId: 's-1', convertedAt: new Date('2026-09-02T08:30:00.000Z') }),
    );

    expect(at(converted, 'Переведён в студенты')).toBe('Да');
    expect(at(converted, 'Дата перевода')).toBe('2026-09-02');
  });

  it('UTM и источник выгружаются разными колонками — отчёт группируется по кампании', () => {
    const values = toCsvRow(
      row({
        source: 'по рекомендации подруги',
        utmSource: 'instagram',
        utmMedium: 'cpc',
        utmCampaign: 'osen-2026',
      }),
    );

    expect(at(values, 'Источник')).toBe('по рекомендации подруги');
    expect(at(values, 'UTM source')).toBe('instagram');
    expect(at(values, 'UTM medium')).toBe('cpc');
    expect(at(values, 'UTM campaign')).toBe('osen-2026');
  });
});
