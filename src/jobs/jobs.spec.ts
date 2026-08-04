import { DirectoryStatus } from '@prisma/client';

import { isJobOpen } from './jobs';

const day = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

const job = (
  overrides: Partial<{ status: DirectoryStatus; deadline: Date | null }> = {},
): { status: DirectoryStatus; deadline: Date | null } => ({
  status: DirectoryStatus.ACTIVE,
  deadline: null,
  ...overrides,
});

describe('isJobOpen (ТЗ 5.18)', () => {
  it('вакансия без срока актуальна всегда: бессрочный набор — законное состояние', () => {
    expect(isJobOpen(job(), day('2026-01-01'))).toBe(true);
    expect(isJobOpen(job(), day('2030-12-31'))).toBe(true);
  });

  it('граница включающая: вакансия «до 30 ноября» открыта тридцатого', () => {
    const untilNovember = job({ deadline: day('2026-11-30') });

    expect(isJobOpen(untilNovember, day('2026-11-30'))).toBe(true);
  });

  it('на следующий день после срока вакансия закрыта', () => {
    const untilNovember = job({ deadline: day('2026-11-30') });

    expect(isJobOpen(untilNovember, day('2026-12-01'))).toBe(false);
  });

  it('срок в далёком будущем — открыта и сегодня, и накануне', () => {
    const untilNextYear = job({ deadline: day('2027-12-31') });

    expect(isJobOpen(untilNextYear, day('2026-08-04'))).toBe(true);
    expect(isJobOpen(untilNextYear, day('2027-12-30'))).toBe(true);
  });

  it('`INACTIVE` не актуальна даже внутри срока: место заняли раньше объявленного дня', () => {
    const closed = job({ status: DirectoryStatus.INACTIVE, deadline: day('2026-11-30') });

    expect(isJobOpen(closed, day('2026-08-04'))).toBe(false);
  });

  it('`INACTIVE` без срока тоже не актуальна', () => {
    expect(isJobOpen(job({ status: DirectoryStatus.INACTIVE }), day('2026-08-04'))).toBe(false);
  });

  it('статус и срок — независимые причины: закрыть можно любой из них', () => {
    const expired = job({ deadline: day('2026-01-01') });
    const disabled = job({ status: DirectoryStatus.INACTIVE });

    // Обе вакансии неактуальны, но по разным причинам — потому в схеме
    // и стоят обе колонки, а не одна.
    expect(isJobOpen(expired, day('2026-08-04'))).toBe(false);
    expect(isJobOpen(disabled, day('2026-08-04'))).toBe(false);
  });

  it('срок ровно сегодня — последний день приёма откликов', () => {
    const today = job({ deadline: day('2026-08-04') });

    expect(isJobOpen(today, day('2026-08-03'))).toBe(true);
    expect(isJobOpen(today, day('2026-08-04'))).toBe(true);
    expect(isJobOpen(today, day('2026-08-05'))).toBe(false);
  });
});
