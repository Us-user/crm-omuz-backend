import type { INestApplication } from '@nestjs/common';
import type { OpenAPIObject } from '@nestjs/swagger';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

import { ApiErrorDto } from './common';
import { API_PREFIX } from './constants';

/**
 * Собирает OpenAPI-документ, не монтируя его в приложение.
 *
 * Отдельно от `setupSwagger`, потому что документ нужен и тестам: маршрут
 * `/docs/json` существует только при `SWAGGER_ENABLED=true` (в CI он выключен),
 * а проверять описание эндпоинтов надо всегда.
 */
export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('CRM «Omuz» — API')
    .setDescription(
      [
        'Бэкенд CRM обучающего центра «Omuz».',
        '',
        'Формат успешного ответа: `{ "data": ..., "meta": ... }`.',
        'Формат ошибки: `{ "error": { "code", "message", "details" } }`.',
        'Списки постраничные: query `page` (с 1) и `limit` (по умолчанию 20).',
      ].join('\n'),
    )
    .setVersion('1.0')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'access-token')
    // `addServer` здесь не нужен: глобальный префикс уже входит в пути документа,
    // иначе «Try it out» бил бы в `/api/v1/api/v1/...`.
    .build();

  return SwaggerModule.createDocument(app, config, { extraModels: [ApiErrorDto] });
}

/** Swagger/OpenAPI на `/api/v1/docs` (ТЗ 3.5). */
export function setupSwagger(app: INestApplication): void {
  SwaggerModule.setup(`${API_PREFIX}/docs`, app, buildOpenApiDocument(app), {
    jsonDocumentUrl: `${API_PREFIX}/docs/json`,
    swaggerOptions: { persistAuthorization: true },
  });
}
