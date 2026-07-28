import { Prisma } from '@prisma/client';

import type { DebtorChargeTotals, DebtorDebt } from './accounting';
import {
  ChargeStatus,
  chargeStatusOf,
  dueCentsOf,
  fromCents,
  summarizeDebtors,
  toCents,
  totalsOf,
} from './accounting';

const STUDENT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const STUDENT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const STUDENT_C = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

describe('деньги в тыйинах', () => {
  it('переводит сомони в тыйины без потери копеек', () => {
    expect(toCents('1200.50')).toBe(120050);
    expect(toCents(1200.5)).toBe(120050);
    expect(toCents(new Prisma.Decimal('1200.50'))).toBe(120050);
  });

  it('снимает шум двоичной плавающей точки на третьем знаке', () => {
    // 1234.56 * 100 в double даёт 123455.99999999999 — без округления
    // копейка терялась бы на каждой второй сумме.
    expect(toCents(1234.56)).toBe(123456);
    expect(toCents(0.29)).toBe(29);
    expect(toCents(19.99)).toBe(1999);
  });

  it('переводит обратно в сомони с двумя знаками', () => {
    expect(fromCents(120050)).toBe(1200.5);
    expect(fromCents(0)).toBe(0);
    expect(fromCents(1)).toBe(0.01);
  });

  it('вычитание в тыйинах не даёт «копейки долга» на ровной сумме', () => {
    // 1200.30 − 400.10 в double это 800.1999999999999: в отчёте по должникам
    // такой остаток выглядел бы как незакрытый месяц.
    const remaining = toCents('1200.30') - toCents('400.10') - toCents('800.20');

    expect(remaining).toBe(0);
  });

  it('к оплате — начислено минус скидка', () => {
    expect(dueCentsOf('1200.00', '200.00')).toBe(100000);
    expect(dueCentsOf('1200.00', '0')).toBe(120000);
  });

  it('скидка больше начисления не даёт отрицательного долга', () => {
    expect(dueCentsOf('1200.00', '1500.00')).toBe(0);
  });
});

describe('chargeStatusOf', () => {
  it('месяц без денег — «Not paid» из ТЗ 5.16', () => {
    expect(chargeStatusOf(120000, 0)).toBe(ChargeStatus.NotPaid);
  });

  it('часть денег — «оплачен частично»', () => {
    expect(chargeStatusOf(120000, 40000)).toBe(ChargeStatus.Partial);
  });

  it('вся сумма — «оплачен»', () => {
    expect(chargeStatusOf(120000, 120000)).toBe(ChargeStatus.Paid);
  });

  it('месяц с полной скидкой закрыт, хотя денег по нему нет', () => {
    expect(chargeStatusOf(0, 0)).toBe(ChargeStatus.Paid);
  });

  it('копейка остатка оставляет месяц незакрытым', () => {
    expect(chargeStatusOf(120000, 119999)).toBe(ChargeStatus.Partial);
  });
});

describe('totalsOf', () => {
  it('считает Total payment / Paid / Not paid', () => {
    expect(totalsOf(2400000, 1800000)).toEqual({ charged: 24000, paid: 18000, debt: 6000 });
  });

  it('пустой набор отдаёт нули, а не пропущенные поля', () => {
    expect(totalsOf(0, 0)).toEqual({ charged: 0, paid: 0, debt: 0 });
  });

  it('долг не уходит в минус даже на испорченных данных', () => {
    expect(totalsOf(100000, 150000).debt).toBe(0);
  });
});

const debt = (overrides: Partial<DebtorDebt> = {}): DebtorDebt => ({
  studentId: STUDENT_A,
  debtCents: 240000,
  unpaidMonths: 2,
  oldestUnpaidMonth: new Date('2026-08-01T00:00:00.000Z'),
  ...overrides,
});

const totals = (rows: DebtorChargeTotals[]): Map<string, DebtorChargeTotals> =>
  new Map(rows.map((row) => [row.studentId, row]));

describe('summarizeDebtors', () => {
  it('собирает строку должника из трёх агрегатов', () => {
    const rows = summarizeDebtors(
      [debt()],
      totals([{ studentId: STUDENT_A, chargedCents: 360000, paidCents: 120000 }]),
      new Map([[STUDENT_A, 50000]]),
    );

    expect(rows).toEqual([
      {
        studentId: STUDENT_A,
        chargedCents: 360000,
        paidCents: 120000,
        debtCents: 240000,
        prepaidCents: 50000,
        unpaidMonths: 2,
        oldestUnpaidMonth: new Date('2026-08-01T00:00:00.000Z'),
      },
    ]);
  });

  it('предоплата долг не гасит — она стоит отдельным числом', () => {
    const [row] = summarizeDebtors(
      [debt({ debtCents: 100000 })],
      totals([{ studentId: STUDENT_A, chargedCents: 100000, paidCents: 0 }]),
      new Map([[STUDENT_A, 300000]]),
    );

    expect(row).toMatchObject({ debtCents: 100000, prepaidCents: 300000 });
  });

  it('без предоплаты в строке стоит ноль, а не пропущенное поле', () => {
    const [row] = summarizeDebtors(
      [debt()],
      totals([{ studentId: STUDENT_A, chargedCents: 240000, paidCents: 0 }]),
      new Map(),
    );

    expect(row.prepaidCents).toBe(0);
  });

  it('рассчитавшийся студент в витрину не попадает', () => {
    const rows = summarizeDebtors(
      [debt({ debtCents: 0, unpaidMonths: 0, oldestUnpaidMonth: null })],
      totals([{ studentId: STUDENT_A, chargedCents: 240000, paidCents: 240000 }]),
      new Map(),
    );

    expect(rows).toEqual([]);
  });

  it('сортирует по убыванию долга', () => {
    const rows = summarizeDebtors(
      [
        debt({ studentId: STUDENT_A, debtCents: 50000 }),
        debt({ studentId: STUDENT_B, debtCents: 300000 }),
        debt({ studentId: STUDENT_C, debtCents: 120000 }),
      ],
      totals([]),
      new Map(),
    );

    expect(rows.map(({ studentId }) => studentId)).toEqual([STUDENT_B, STUDENT_C, STUDENT_A]);
  });

  it('при равном долге порядок устойчив — иначе строка приходила бы на двух страницах', () => {
    const first = summarizeDebtors(
      [debt({ studentId: STUDENT_B }), debt({ studentId: STUDENT_A })],
      totals([]),
      new Map(),
    );
    const second = summarizeDebtors(
      [debt({ studentId: STUDENT_A }), debt({ studentId: STUDENT_B })],
      totals([]),
      new Map(),
    );

    expect(first.map(({ studentId }) => studentId)).toEqual([STUDENT_A, STUDENT_B]);
    expect(second.map(({ studentId }) => studentId)).toEqual([STUDENT_A, STUDENT_B]);
  });

  it('без агрегата начислений показывает долг, а не ноль начислений', () => {
    const [row] = summarizeDebtors([debt({ debtCents: 90000 })], totals([]), new Map());

    expect(row).toMatchObject({ chargedCents: 90000, paidCents: 0, debtCents: 90000 });
  });

  it('самый ранний незакрытый месяц приходит из агрегата', () => {
    const [row] = summarizeDebtors(
      [debt({ oldestUnpaidMonth: new Date('2026-01-01T00:00:00.000Z') })],
      totals([]),
      new Map(),
    );

    expect(row.oldestUnpaidMonth).toEqual(new Date('2026-01-01T00:00:00.000Z'));
  });

  it('не меняет вход', () => {
    const input = [debt()];
    const copy = [...input];

    summarizeDebtors(input, totals([]), new Map());

    expect(input).toEqual(copy);
  });
});
