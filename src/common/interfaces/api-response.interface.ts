/** Метаданные ответа (ТЗ 3.5): пагинация и произвольные доменные поля. */
export interface ResponseMeta {
  total?: number;
  page?: number;
  limit?: number;
  totalPages?: number;
  [key: string]: unknown;
}

/** Успешный ответ: `{ data, meta }`. */
export interface ApiSuccessResponse<T> {
  data: T;
  meta?: ResponseMeta;
}

/** Ответ с ошибкой: `{ error: { code, message, details } }`. */
export interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
    details?: unknown;
    requestId?: string;
    timestamp: string;
  };
}
