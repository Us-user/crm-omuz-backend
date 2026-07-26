import { SetMetadata } from '@nestjs/common';

import { IS_PUBLIC_KEY } from '../auth.constants';

/**
 * Снимает требование access-токена с эндпоинта.
 *
 * По умолчанию закрыто всё (ТЗ 3.8): `JwtAuthGuard` зарегистрирован глобально,
 * поэтому забыть повесить guard на новый эндпоинт нельзя — можно только
 * осознанно открыть его этим декоратором.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
