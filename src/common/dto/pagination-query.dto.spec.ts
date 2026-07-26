import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import {
  DEFAULT_LIMIT,
  DEFAULT_PAGE,
  MAX_LIMIT,
  PaginationQueryDto,
  SortOrder,
} from './pagination-query.dto';

const build = (raw: Record<string, unknown>): PaginationQueryDto =>
  plainToInstance(PaginationQueryDto, raw, { exposeDefaultValues: true });

describe('PaginationQueryDto', () => {
  it('использует значения по умолчанию (page=1, limit=20)', () => {
    const dto = build({});

    expect(validateSync(dto)).toHaveLength(0);
    expect(dto.page).toBe(DEFAULT_PAGE);
    expect(dto.limit).toBe(DEFAULT_LIMIT);
    expect(dto.order).toBe(SortOrder.Desc);
  });

  it('считает skip и take для Prisma', () => {
    const dto = build({ page: '3', limit: '10' });

    expect(validateSync(dto)).toHaveLength(0);
    expect(dto.skip).toBe(20);
    expect(dto.take).toBe(10);
  });

  it('не пропускает limit выше максимума и page меньше 1', () => {
    expect(validateSync(build({ limit: String(MAX_LIMIT + 1) }))).not.toHaveLength(0);
    expect(validateSync(build({ page: '0' }))).not.toHaveLength(0);
  });

  it('обрезает пробелы в search', () => {
    const dto = build({ search: '  Ахмад  ' });

    expect(validateSync(dto)).toHaveLength(0);
    expect(dto.search).toBe('Ахмад');
  });
});
