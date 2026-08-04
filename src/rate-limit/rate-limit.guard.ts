import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';

import { TooManyRequestsException } from '../common';
import { AppConfigService } from '../config';
import { PhoneService } from '../phone';
import type { RateLimitRule, RateLimitSubjectRule } from './rate-limit';
import {
  clientIpOf,
  ipRateLimitKey,
  RATE_LIMIT_KEY,
  subjectRateLimitKey,
  subjectValueOf,
} from './rate-limit';
import type { RateLimitVerdict } from './rate-limit.service';
import { RateLimitService } from './rate-limit.service';

/**
 * Применяет правило `@RateLimit(...)` (ТЗ 3.8).
 *
 * **Ставится декоратором, а не глобально** — как `PermissionsGuard` (0005):
 * лимит объявляет эндпоинт, и правило вместе с его применением должно
 * приезжать одним декоратором, иначе достаточно забыть `@UseGuards`.
 *
 * **Работает до `ValidationPipe`** — так устроен цикл Nest, и это осознанно:
 * неверно заполненная форма расходует лимит наравне с верной, иначе перебор
 * шёл бы заведомо ломаным запросом мимо всякого счёта.
 *
 * **Счётчики проверяются по очереди и с ранним выходом.** Если исчерпан лимит
 * по адресу, счётчик по логину не трогается: иначе перебор с одной машины
 * накручивал бы чужому человеку лимит на вход, то есть закрывал бы вход тому,
 * кого защищает.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RateLimitGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly limiter: RateLimitService,
    private readonly phones: PhoneService,
    private readonly config: AppConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Задачи очереди и прочие не-HTTP вызовы лимитом не ограничиваются:
    // ни адреса, ни тела запроса у них нет.
    if (context.getType() !== 'http') return true;

    const rule = this.reflector.getAllAndOverride<RateLimitRule | undefined>(RATE_LIMIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!rule || !this.config.rateLimitEnabled) return true;

    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();

    const ip = clientIpOf(request);
    const byIp = await this.limiter.hit(ipRateLimitKey(rule.action, ip), rule.ip);
    if (byIp.exceeded) {
      this.reject(response, rule, byIp, `адрес ${ip}`);
    }

    if (rule.subject) {
      const value = this.subjectOf(request.body, rule.subject);

      // Значения нет (поле пустое, не строка или запредельно длинное) —
      // остаётся один счётчик по адресу, а форму отобьёт `ValidationPipe`.
      if (value !== null) {
        const bySubject = await this.limiter.hit(
          subjectRateLimitKey(rule.action, value),
          rule.subject,
        );
        if (bySubject.exceeded) {
          this.reject(response, rule, bySubject, `логин с адреса ${ip}`);
        }
      }
    }

    return true;
  }

  /**
   * Приводит значение к тому же виду, в каком его увидит сервис: телефон —
   * в E.164 (`PhoneService`, 0002), почту — к нижнему регистру. Без этого
   * `901234567` и `+992901234567` считались бы двумя разными людьми,
   * и лимит обходился бы сменой формы записи.
   *
   * Разбор телефона здесь **не должен ронять запрос**: guard стоит раньше
   * валидации, и 400 на кривой номер обязан прийти из `ValidationPipe`
   * с внятным `details`, а не из лимитера.
   */
  private subjectOf(body: unknown, subject: RateLimitSubjectRule): string | null {
    const raw = subjectValueOf(body, subject.field);
    if (raw === null) return null;

    if (subject.kind === 'email') return raw.toLowerCase();

    try {
      return this.phones.normalize(raw, subject.field);
    } catch {
      // Номер не разобрался — считаем по тому, что прислали. Такой запрос
      // всё равно закончится 400, но лимит он расходует.
      return raw.toLowerCase();
    }
  }

  private reject(
    response: Response,
    rule: RateLimitRule,
    verdict: RateLimitVerdict,
    who: string,
  ): never {
    this.logger.warn(
      `Превышен лимит «${rule.action}» (${who}): следующая попытка через ${String(verdict.retryAfterSeconds)} с`,
    );

    // Заголовок ставится до исключения: фильтр ошибок только пишет тело
    // и код, уже проставленные заголовки он не трогает.
    response.setHeader('Retry-After', String(verdict.retryAfterSeconds));

    throw new TooManyRequestsException(verdict.retryAfterSeconds);
  }
}
