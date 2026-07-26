import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request, Response } from 'express';

import { ErrorCode, errorCodeForStatus } from '../errors/error-code.enum';
import type { ApiErrorResponse } from '../interfaces/api-response.interface';

interface NormalizedError {
  status: number;
  code: string;
  message: string;
  details?: unknown;
}

/**
 * Единая точка преобразования любых исключений в формат
 * `{ error: { code, message, details } }` (ТЗ 3.5).
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const normalized = this.normalize(exception);
    // `id` проставляет pino-http (см. LoggerModule в AppModule).
    const rawRequestId = (request as { id?: unknown }).id;
    const requestId =
      typeof rawRequestId === 'string' || typeof rawRequestId === 'number'
        ? String(rawRequestId)
        : undefined;

    if (normalized.status >= 500) {
      this.logger.error(
        `${request.method} ${request.url} → ${normalized.status}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    const body: ApiErrorResponse = {
      error: {
        code: normalized.code,
        message: normalized.message,
        ...(normalized.details !== undefined ? { details: normalized.details } : {}),
        ...(requestId ? { requestId } : {}),
        timestamp: new Date().toISOString(),
      },
    };

    response.status(normalized.status).json(body);
  }

  private normalize(exception: unknown): NormalizedError {
    if (exception instanceof HttpException) {
      return this.fromHttpException(exception);
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      return this.fromPrismaError(exception);
    }

    if (exception instanceof Prisma.PrismaClientValidationError) {
      return {
        status: HttpStatus.BAD_REQUEST,
        code: ErrorCode.ValidationError,
        message: 'Некорректный запрос к базе данных',
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: ErrorCode.InternalError,
      message: 'Внутренняя ошибка сервера',
    };
  }

  private fromHttpException(exception: HttpException): NormalizedError {
    const status = exception.getStatus();
    const payload = exception.getResponse();
    const fallbackCode = errorCodeForStatus(status);

    if (typeof payload === 'string') {
      return { status, code: fallbackCode, message: payload };
    }

    const record = payload as Record<string, unknown>;
    const rawMessage = record.message;

    // ValidationPipe отдаёт message массивом строк — переносим его в details.
    if (Array.isArray(rawMessage)) {
      return {
        status,
        code: fallbackCode,
        message: 'Ошибка валидации входных данных',
        details: rawMessage,
      };
    }

    return {
      status,
      code: typeof record.code === 'string' ? record.code : fallbackCode,
      message: typeof rawMessage === 'string' ? rawMessage : exception.message,
      details: record.details,
    };
  }

  private fromPrismaError(exception: Prisma.PrismaClientKnownRequestError): NormalizedError {
    const target = exception.meta?.target;

    switch (exception.code) {
      case 'P2002':
        return {
          status: HttpStatus.CONFLICT,
          code: ErrorCode.Conflict,
          message: 'Запись с такими значениями уже существует',
          details: target,
        };
      case 'P2003':
        return {
          status: HttpStatus.CONFLICT,
          code: ErrorCode.Conflict,
          message: 'Нарушение связи между записями',
          details: exception.meta?.field_name,
        };
      case 'P2025':
        return {
          status: HttpStatus.NOT_FOUND,
          code: ErrorCode.NotFound,
          message: 'Запись не найдена',
        };
      default:
        return {
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          code: ErrorCode.InternalError,
          message: 'Ошибка базы данных',
        };
    }
  }
}
