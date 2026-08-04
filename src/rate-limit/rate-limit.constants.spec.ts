import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import { ForgotPasswordDto, LoginDto, ResetPasswordDto } from '../auth/dto';
import type { RateLimitRule } from './rate-limit';
import {
  LOGIN_RATE_LIMIT,
  PASSWORD_FORGOT_RATE_LIMIT,
  PASSWORD_RESET_RATE_LIMIT,
  REFRESH_RATE_LIMIT,
  REGISTER_RATE_LIMIT,
} from './rate-limit.constants';

/**
 * Поля, объявленные в DTO: пустой объект нарушает все обязательные правила
 * сразу, и `property` каждой ошибки — это и есть имя объявленного поля.
 */
const declaredFieldsOf = (dto: new () => object): string[] =>
  validateSync(plainToInstance(dto, {})).map((error) => error.property);

const ALL: RateLimitRule[] = [
  REGISTER_RATE_LIMIT,
  LOGIN_RATE_LIMIT,
  REFRESH_RATE_LIMIT,
  PASSWORD_FORGOT_RATE_LIMIT,
  PASSWORD_RESET_RATE_LIMIT,
];

describe('правила лимитов', () => {
  it('имя действия у каждого своё — иначе счётчики эндпоинтов смешались бы', () => {
    const actions = ALL.map((rule) => rule.action);

    expect(new Set(actions).size).toBe(actions.length);
  });

  it('все окна и лимиты положительные', () => {
    for (const rule of ALL) {
      expect(rule.ip.limit).toBeGreaterThan(0);
      expect(rule.ip.windowSeconds).toBeGreaterThan(0);

      if (rule.subject) {
        expect(rule.subject.limit).toBeGreaterThan(0);
        expect(rule.subject.windowSeconds).toBeGreaterThan(0);
      }
    }
  });

  it('поле второго счётчика объявлено в DTO своего эндпоинта', () => {
    // Опечатка в имени поля молча оставила бы эндпоинт с одним счётчиком:
    // `subjectValueOf` вернул бы null, и никто бы этого не заметил.
    expect(declaredFieldsOf(LoginDto)).toContain(LOGIN_RATE_LIMIT.subject?.field);
    expect(declaredFieldsOf(ForgotPasswordDto)).toContain(
      PASSWORD_FORGOT_RATE_LIMIT.subject?.field,
    );
    expect(declaredFieldsOf(ResetPasswordDto)).toContain(PASSWORD_RESET_RATE_LIMIT.subject?.field);
  });

  it('второго счётчика нет там, где его не из чего собрать', () => {
    // У регистрации логина ещё нет, у обновления токенов в теле только токен.
    expect(REGISTER_RATE_LIMIT.subject).toBeUndefined();
    expect(REFRESH_RATE_LIMIT.subject).toBeUndefined();
  });

  it('лимит по адресу щедрее лимита по логину: за одним адресом сидит не один человек', () => {
    expect(LOGIN_RATE_LIMIT.ip.limit).toBeGreaterThan(LOGIN_RATE_LIMIT.subject?.limit ?? 0);
  });
});
