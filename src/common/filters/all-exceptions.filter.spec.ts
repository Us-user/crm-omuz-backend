import type { ArgumentsHost } from '@nestjs/common';
import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { BusinessRuleException } from '../errors/business-rule.exception';
import { AllExceptionsFilter } from './all-exceptions.filter';

interface CapturedResponse {
  status: number;
  body: { error: { code: string; message: string; details?: unknown; requestId?: string } };
}

const runFilter = (exception: unknown, requestId?: string): CapturedResponse => {
  const captured = {} as CapturedResponse;

  const response = {
    status(code: number) {
      captured.status = code;
      return this;
    },
    json(body: CapturedResponse['body']) {
      captured.body = body;
      return this;
    },
  };

  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => ({ method: 'GET', url: '/api/v1/тест', id: requestId }),
    }),
  } as unknown as ArgumentsHost;

  new AllExceptionsFilter().catch(exception, host);

  return captured;
};

describe('AllExceptionsFilter', () => {
  // Фильтр логирует 5xx со стектрейсом — в выводе тестов это лишний шум.
  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  it.each([
    [new UnauthorizedException('Нужен вход'), HttpStatus.UNAUTHORIZED, 'UNAUTHORIZED'],
    [new ForbiddenException('Нет прав'), HttpStatus.FORBIDDEN, 'FORBIDDEN'],
    [new NotFoundException('Не найдено'), HttpStatus.NOT_FOUND, 'NOT_FOUND'],
    [new ConflictException('Номер занят'), HttpStatus.CONFLICT, 'CONFLICT'],
  ])('переводит %#-е исключение Nest в код %s', (exception, status, code) => {
    const result = runFilter(exception);

    expect(result.status).toBe(status);
    expect(result.body.error.code).toBe(code);
  });

  it('отдаёт 422 с деталями для нарушения бизнес-правила', () => {
    const result = runFilter(new BusinessRuleException('Списание запрещено', { balance: 3 }));

    expect(result.status).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect(result.body.error).toMatchObject({
      code: 'UNPROCESSABLE_ENTITY',
      message: 'Списание запрещено',
      details: { balance: 3 },
    });
  });

  it('переносит список ошибок ValidationPipe в details', () => {
    const exception = new HttpException(
      { message: ['phone must be a valid phone number'], statusCode: 400 },
      HttpStatus.BAD_REQUEST,
    );

    const result = runFilter(exception);

    expect(result.status).toBe(HttpStatus.BAD_REQUEST);
    expect(result.body.error.code).toBe('VALIDATION_ERROR');
    expect(result.body.error.details).toEqual(['phone must be a valid phone number']);
  });

  it('переводит нарушение уникальности Prisma (P2002) в 409', () => {
    const exception = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'test',
      meta: { target: ['phone'] },
    });

    const result = runFilter(exception);

    expect(result.status).toBe(HttpStatus.CONFLICT);
    expect(result.body.error).toMatchObject({ code: 'CONFLICT', details: ['phone'] });
  });

  it('переводит «запись не найдена» Prisma (P2025) в 404', () => {
    const exception = new Prisma.PrismaClientKnownRequestError('Not found', {
      code: 'P2025',
      clientVersion: 'test',
    });

    const result = runFilter(exception);

    expect(result.status).toBe(HttpStatus.NOT_FOUND);
    expect(result.body.error.code).toBe('NOT_FOUND');
  });

  it('скрывает детали неизвестной ошибки за 500', () => {
    const result = runFilter(new Error('пароль=secret в стектрейсе'));

    expect(result.status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(result.body.error).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'Внутренняя ошибка сервера',
      timestamp: expect.any(String),
    });
  });

  it('прокидывает requestId, когда он есть у запроса', () => {
    expect(runFilter(new NotFoundException(), 'req-42').body.error.requestId).toBe('req-42');
    expect(runFilter(new NotFoundException()).body.error.requestId).toBeUndefined();
  });
});
