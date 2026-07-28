import { DirectoryStatus } from '@prisma/client';

import { isCouponValidOn } from './coupons';

const day = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

const coupon = (
  overrides: Partial<{
    status: DirectoryStatus;
    validFrom: Date | null;
    validTo: Date | null;
  }> = {},
) => ({
  status: DirectoryStatus.ACTIVE,
  validFrom: null,
  validTo: null,
  ...overrides,
});

describe('isCouponValidOn (ТЗ 5.7)', () => {
  it('купон без границ периода действует всегда: бессрочная акция — законное состояние', () => {
    expect(isCouponValidOn(coupon(), day('2026-01-01'))).toBe(true);
    expect(isCouponValidOn(coupon(), day('2030-12-31'))).toBe(true);
  });

  it('обе границы включающие: купон «с 1 по 30 ноября» действует и первого, и тридцатого', () => {
    const november = coupon({ validFrom: day('2026-11-01'), validTo: day('2026-11-30') });

    expect(isCouponValidOn(november, day('2026-11-01'))).toBe(true);
    expect(isCouponValidOn(november, day('2026-11-30'))).toBe(true);
  });

  it('день до начала и день после конца — не действует', () => {
    const november = coupon({ validFrom: day('2026-11-01'), validTo: day('2026-11-30') });

    expect(isCouponValidOn(november, day('2026-10-31'))).toBe(false);
    expect(isCouponValidOn(november, day('2026-12-01'))).toBe(false);
  });

  it('открытое начало: «до 30 ноября» действует и в прошлом году', () => {
    const untilNovember = coupon({ validTo: day('2026-11-30') });

    expect(isCouponValidOn(untilNovember, day('2025-01-01'))).toBe(true);
    expect(isCouponValidOn(untilNovember, day('2026-12-01'))).toBe(false);
  });

  it('открытый конец: «с 1 сентября» действует и через год', () => {
    const fromSeptember = coupon({ validFrom: day('2026-09-01') });

    expect(isCouponValidOn(fromSeptember, day('2026-08-31'))).toBe(false);
    expect(isCouponValidOn(fromSeptember, day('2027-09-01'))).toBe(true);
  });

  it('`INACTIVE` не действует даже внутри периода: акцию выключили раньше срока', () => {
    const disabled = coupon({
      status: DirectoryStatus.INACTIVE,
      validFrom: day('2026-11-01'),
      validTo: day('2026-11-30'),
    });

    expect(isCouponValidOn(disabled, day('2026-11-15'))).toBe(false);
  });

  it('`INACTIVE` без границ периода тоже не действует', () => {
    expect(isCouponValidOn(coupon({ status: DirectoryStatus.INACTIVE }), day('2026-11-15'))).toBe(
      false,
    );
  });

  it('однодневная акция действует ровно один день', () => {
    const oneDay = coupon({ validFrom: day('2026-11-11'), validTo: day('2026-11-11') });

    expect(isCouponValidOn(oneDay, day('2026-11-10'))).toBe(false);
    expect(isCouponValidOn(oneDay, day('2026-11-11'))).toBe(true);
    expect(isCouponValidOn(oneDay, day('2026-11-12'))).toBe(false);
  });
});
