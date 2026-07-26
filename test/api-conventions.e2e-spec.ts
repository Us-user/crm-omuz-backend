import type { INestApplication } from '@nestjs/common';
import { Body, Controller, Get, Module, Post, Query, ValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { IsString, MinLength } from 'class-validator';
import { Logger } from 'nestjs-pino';
import request from 'supertest';

import {
  AllExceptionsFilter,
  BusinessRuleException,
  Paginated,
  PaginationQueryDto,
  TransformResponseInterceptor,
} from 'src/common';
import { AppConfigModule } from 'src/config/config.module';
import { API_PREFIX, PREFIX_EXCLUDED_ROUTES } from 'src/constants';
import { LoggerModule } from 'src/logger/logger.module';
import { setupSwagger } from 'src/swagger';

// Конвенции API не зависят от БД/Redis, поэтому проверяем их на изолированном
// модуле: настоящие глобальные pipe/filter/interceptor + тестовый контроллер.
// Окружение подготавливает `test/setup-env.ts`; подключения к БД здесь не происходит.

class CreateThingDto {
  @IsString()
  @MinLength(3)
  title!: string;
}

@Controller('things')
class ThingsController {
  @Get()
  list(@Query() query: PaginationQueryDto): Paginated<{ id: number }> {
    return new Paginated([{ id: 1 }, { id: 2 }], 42, query.page, query.limit);
  }

  @Get('one')
  one(): { id: number; title: string } {
    return { id: 1, title: 'Курс' };
  }

  @Get('business-error')
  businessError(): never {
    throw new BusinessRuleException('Списание коинов запрещено', { balance: 12 });
  }

  @Get('boom')
  boom(): never {
    throw new Error('неожиданная ошибка');
  }

  @Post()
  create(@Body() dto: CreateThingDto): CreateThingDto {
    return dto;
  }
}

@Module({
  imports: [AppConfigModule, LoggerModule],
  controllers: [ThingsController],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: TransformResponseInterceptor },
  ],
})
class ConventionsTestModule {}

describe('Конвенции API (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConventionsTestModule],
    }).compile();

    app = moduleRef.createNestApplication({ bufferLogs: true });
    app.useLogger(app.get(Logger));
    app.setGlobalPrefix(API_PREFIX, { exclude: PREFIX_EXCLUDED_ROUTES });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: false },
        validateCustomDecorators: true,
      }),
    );
    setupSwagger(app);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('успешные ответы', () => {
    it('оборачивает объект в { data }', async () => {
      const response = await request(app.getHttpServer()).get('/api/v1/things/one').expect(200);

      expect(response.body).toEqual({ data: { id: 1, title: 'Курс' } });
    });

    it('отдаёт список как { data, meta } с пагинацией', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/things?page=2&limit=20')
        .expect(200);

      expect(response.body.data).toHaveLength(2);
      expect(response.body.meta).toEqual({ total: 42, page: 2, limit: 20, totalPages: 3 });
    });

    it('подставляет page=1 и limit=20 по умолчанию', async () => {
      const response = await request(app.getHttpServer()).get('/api/v1/things').expect(200);

      expect(response.body.meta).toMatchObject({ page: 1, limit: 20 });
    });
  });

  describe('префикс /api/v1', () => {
    it('маршрут вне префикса недоступен', async () => {
      await request(app.getHttpServer()).get('/things/one').expect(404);
    });
  });

  describe('ошибки', () => {
    it('404 в формате { error } с кодом NOT_FOUND', async () => {
      const response = await request(app.getHttpServer()).get('/api/v1/нет-такого').expect(404);

      expect(response.body).not.toHaveProperty('data');
      expect(response.body.error).toMatchObject({
        code: 'NOT_FOUND',
        message: expect.any(String),
        timestamp: expect.any(String),
      });
    });

    it('400 с деталями валидации DTO', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/things')
        .send({ title: 'ab' })
        .expect(400);

      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      expect(response.body.error.details).toEqual(
        expect.arrayContaining([expect.stringContaining('title')]),
      );
    });

    it('400 при неизвестном поле в теле (forbidNonWhitelisted)', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/things')
        .send({ title: 'корректно', isAdmin: true })
        .expect(400);

      expect(response.body.error.details).toEqual(
        expect.arrayContaining([expect.stringContaining('isAdmin')]),
      );
    });

    it('400 при некорректном query-параметре пагинации', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/things?limit=1000')
        .expect(400);

      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('422 для нарушения бизнес-правила', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/things/business-error')
        .expect(422);

      expect(response.body.error).toMatchObject({
        code: 'UNPROCESSABLE_ENTITY',
        message: 'Списание коинов запрещено',
        details: { balance: 12 },
      });
    });

    it('500 не раскрывает внутренности наружу', async () => {
      const response = await request(app.getHttpServer()).get('/api/v1/things/boom').expect(500);

      expect(response.body.error).toMatchObject({
        code: 'INTERNAL_ERROR',
        message: 'Внутренняя ошибка сервера',
      });
      expect(JSON.stringify(response.body)).not.toContain('неожиданная ошибка');
    });
  });

  describe('Swagger', () => {
    it('отдаёт OpenAPI-документ на /api/v1/docs/json', async () => {
      const response = await request(app.getHttpServer()).get('/api/v1/docs/json').expect(200);

      expect(response.body.openapi).toMatch(/^3\./);
      expect(response.body.info.title).toBe('CRM «Omuz» — API');
      // Пути уже содержат глобальный префикс — отдельный `server` его бы удвоил.
      expect(Object.keys(response.body.paths)).toContain('/api/v1/things');
      expect(response.body.servers ?? []).toHaveLength(0);
    });

    it('описывает схему ошибки в компонентах', async () => {
      const response = await request(app.getHttpServer()).get('/api/v1/docs/json').expect(200);

      expect(response.body.components.schemas.ApiErrorDto).toBeDefined();
    });
  });

  describe('request-id', () => {
    it('возвращает x-request-id и тот же идентификатор в теле ошибки', async () => {
      const response = await request(app.getHttpServer()).get('/api/v1/нет').expect(404);

      expect(response.headers['x-request-id']).toBeDefined();
      expect(response.body.error.requestId).toBe(response.headers['x-request-id']);
    });

    it('переиспользует входящий x-request-id', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/нет')
        .set('x-request-id', 'trace-12345')
        .expect(404);

      expect(response.body.error.requestId).toBe('trace-12345');
    });
  });
});
