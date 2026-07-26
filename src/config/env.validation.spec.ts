import { LogLevel, NodeEnv, validateEnv } from './env.validation';

const MINIMAL = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db?schema=public',
  JWT_ACCESS_SECRET: 'access-secret-at-least-32-characters-long',
  JWT_REFRESH_SECRET: 'refresh-secret-at-least-32-characters-long',
  PASSWORD_RESET_SECRET: 'password-reset-secret-at-least-32-characters-long',
};

describe('validateEnv', () => {
  it('подставляет значения по умолчанию, когда заданы только обязательные переменные', () => {
    const env = validateEnv({ ...MINIMAL });

    expect(env.NODE_ENV).toBe(NodeEnv.Development);
    expect(env.PORT).toBe(3000);
    expect(env.REDIS_HOST).toBe('127.0.0.1');
    expect(env.REDIS_PORT).toBe(6379);
    expect(env.LOG_LEVEL).toBe(LogLevel.Info);
    expect(env.SWAGGER_ENABLED).toBe(true);
    expect(env.JWT_ACCESS_TTL_SECONDS).toBe(3600);
    expect(env.JWT_REFRESH_TTL_SECONDS).toBe(1_209_600);
    expect(env.DEFAULT_PHONE_REGION).toBe('TJ');
    expect(env.MAIL_FROM).toBe('no-reply@omuz.tj');
  });

  it('падает, если DATABASE_URL не задан', () => {
    expect(() => validateEnv({})).toThrow(/DATABASE_URL/);
  });

  it('требует секреты JWT и отвергает слишком короткие', () => {
    expect(() => validateEnv({ ...MINIMAL, JWT_ACCESS_SECRET: undefined })).toThrow(
      /JWT_ACCESS_SECRET/,
    );
    expect(() => validateEnv({ ...MINIMAL, JWT_REFRESH_SECRET: 'слишком-короткий' })).toThrow(
      /JWT_REFRESH_SECRET/,
    );
  });

  it('требует секрет подписи кодов сброса пароля', () => {
    expect(() => validateEnv({ ...MINIMAL, PASSWORD_RESET_SECRET: undefined })).toThrow(
      /PASSWORD_RESET_SECRET/,
    );
    expect(() => validateEnv({ ...MINIMAL, PASSWORD_RESET_SECRET: 'короткий' })).toThrow(
      /PASSWORD_RESET_SECRET/,
    );
  });

  it('отвергает некорректный адрес отправителя писем', () => {
    expect(() => validateEnv({ ...MINIMAL, MAIL_FROM: 'не-адрес' })).toThrow(/MAIL_FROM/);
  });

  it('отвергает некорректный код региона для телефонов', () => {
    expect(() => validateEnv({ ...MINIMAL, DEFAULT_PHONE_REGION: 'TJK' })).toThrow(
      /DEFAULT_PHONE_REGION/,
    );
  });

  it('приводит числовые переменные из строк', () => {
    const env = validateEnv({ ...MINIMAL, PORT: '8080', REDIS_PORT: '6380', REDIS_DB: '2' });

    expect(env.PORT).toBe(8080);
    expect(env.REDIS_PORT).toBe(6380);
    expect(env.REDIS_DB).toBe(2);
  });

  it('приводит булевы переменные из строк', () => {
    expect(validateEnv({ ...MINIMAL, SWAGGER_ENABLED: 'false' }).SWAGGER_ENABLED).toBe(false);
    expect(validateEnv({ ...MINIMAL, SWAGGER_ENABLED: '1' }).SWAGGER_ENABLED).toBe(true);
  });

  it('трактует пустую строку как «значение не задано» и берёт дефолт', () => {
    expect(validateEnv({ ...MINIMAL, PORT: '' }).PORT).toBe(3000);
  });

  it('отвергает недопустимый NODE_ENV и порт вне диапазона', () => {
    expect(() => validateEnv({ ...MINIMAL, NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
    expect(() => validateEnv({ ...MINIMAL, PORT: '70000' })).toThrow(/PORT/);
  });
});
