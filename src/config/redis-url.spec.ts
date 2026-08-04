import { parseRedisUrl } from './redis-url';

describe('parseRedisUrl', () => {
  it('разбирает внутренний адрес Render (без логина и пароля)', () => {
    expect(parseRedisUrl('redis://red-abc123:6379')).toEqual({
      host: 'red-abc123',
      port: 6379,
      username: undefined,
      password: undefined,
      db: 0,
      tls: false,
    });
  });

  it('разбирает внешний адрес с паролем и TLS', () => {
    expect(parseRedisUrl('rediss://default:s3cret@oregon-keyvalue.render.com:6379')).toEqual({
      host: 'oregon-keyvalue.render.com',
      port: 6379,
      username: 'default',
      password: 's3cret',
      db: 0,
      tls: true,
    });
  });

  it('пустые логин и пароль означают «не задано», а не пустую строку', () => {
    // ioredis, получив пустую строку, попытается аутентифицироваться ею
    // и упрётся в ошибку вместо анонимного подключения.
    const parsed = parseRedisUrl('redis://:@localhost:6379');

    expect(parsed.username).toBeUndefined();
    expect(parsed.password).toBeUndefined();
  });

  it('пароль со спецсимволами раскодируется', () => {
    expect(parseRedisUrl('redis://:p%40ss%3Aword@host:6379').password).toBe('p@ss:word');
  });

  it('без порта берётся 6379', () => {
    expect(parseRedisUrl('redis://localhost').port).toBe(6379);
  });

  it('номер базы берётся из пути', () => {
    expect(parseRedisUrl('redis://localhost:6379/3').db).toBe(3);
    expect(parseRedisUrl('redis://localhost:6379/').db).toBe(0);
    expect(parseRedisUrl('redis://localhost:6379').db).toBe(0);
  });

  it('обрезает пробелы вокруг строки', () => {
    // Значение, скопированное из дашборда, часто приезжает с переводом строки.
    expect(parseRedisUrl('  redis://localhost:6379\n').host).toBe('localhost');
  });

  it('чужая схема отвергается с внятной причиной', () => {
    // Приложение должно упасть при старте, а не подключаться в никуда.
    expect(() => parseRedisUrl('postgresql://localhost:5432')).toThrow(/redis:\/\//);
    expect(() => parseRedisUrl('http://localhost:6379')).toThrow(/redis:\/\//);
  });

  it('нестрока-URL отвергается', () => {
    expect(() => parseRedisUrl('просто текст')).toThrow(/не удалось разобрать/);
  });

  it('некорректный номер базы отвергается', () => {
    expect(() => parseRedisUrl('redis://localhost:6379/abc')).toThrow(/номер базы/);
    expect(() => parseRedisUrl('redis://localhost:6379/-1')).toThrow(/номер базы/);
  });
});
