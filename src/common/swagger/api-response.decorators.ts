import type { Type } from '@nestjs/common';
import { applyDecorators, HttpStatus } from '@nestjs/common';
import { ApiExtraModels, ApiOkResponse, ApiResponse, getSchemaPath } from '@nestjs/swagger';

import { ApiErrorDto } from './api-error.dto';

const META_SCHEMA = {
  type: 'object' as const,
  properties: {
    total: { type: 'integer' as const, example: 137 },
    page: { type: 'integer' as const, example: 1 },
    limit: { type: 'integer' as const, example: 20 },
    totalPages: { type: 'integer' as const, example: 7 },
  },
};

/**
 * Документирует ответ `{ data: <Model> }`.
 *
 * `status` указывается там, где эндпоинт отвечает не 200: иначе в OpenAPI
 * оказался бы код, которого сервер не возвращает.
 */
export const ApiDataResponse = <TModel extends Type<unknown>>(
  model: TModel,
  options: { description?: string; status?: number } = {},
) =>
  applyDecorators(
    ApiExtraModels(model),
    ApiResponse({
      status: options.status ?? HttpStatus.OK,
      description: options.description,
      schema: {
        type: 'object',
        required: ['data'],
        properties: { data: { $ref: getSchemaPath(model) } },
      },
    }),
  );

/** Документирует постраничный ответ `{ data: <Model>[], meta }` (ТЗ 3.5). */
export const ApiPaginatedResponse = <TModel extends Type<unknown>>(
  model: TModel,
  options: { description?: string } = {},
) =>
  applyDecorators(
    ApiExtraModels(model),
    ApiOkResponse({
      description: options.description,
      schema: {
        type: 'object',
        required: ['data', 'meta'],
        properties: {
          data: { type: 'array', items: { $ref: getSchemaPath(model) } },
          meta: META_SCHEMA,
        },
      },
    }),
  );

/** Набор стандартных ответов-ошибок для защищённых эндпоинтов. */
export const ApiStandardErrors = (...statuses: number[]) =>
  applyDecorators(
    ApiExtraModels(ApiErrorDto),
    ...statuses.map((status) =>
      ApiResponse({ status, schema: { $ref: getSchemaPath(ApiErrorDto) } }),
    ),
  );
