import { Logger } from '@nestjs/common';

import type { RedisService } from '../redis/redis.service';
import { RateLimitService } from './rate-limit.service';

const WINDOW = { limit: 3, windowSeconds: 900 };

describe('RateLimitService', () => {
  let eval_: jest.Mock;
  let del: jest.Mock;
  let service: RateLimitService;
  let warn: jest.SpyInstance;

  beforeEach(() => {
    eval_ = jest.fn();
    del = jest.fn();
    service = new RateLimitService({ client: { eval: eval_, del } } as unknown as RedisService);
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('hit', () => {
    it('считает обращение одной командой и пропускает, пока лимит не исчерпан', async () => {
      eval_.mockResolvedValue([1, 900_000]);

      const verdict = await service.hit('rl:auth.login:ip:10.0.0.1', WINDOW);

      expect(verdict).toEqual({ exceeded: false, retryAfterSeconds: 900, degraded: false });
      // Одна команда, а не INCR + EXPIRE двумя: между ними ключ остался бы
      // без срока навсегда, если бы соединение оборвалось.
      expect(eval_).toHaveBeenCalledTimes(1);
      expect(eval_).toHaveBeenCalledWith(
        expect.stringContaining('INCR'),
        1,
        'rl:auth.login:ip:10.0.0.1',
        '900000',
      );
    });

    it('окно передаётся в миллисекундах', async () => {
      eval_.mockResolvedValue([1, 1000]);

      await service.hit('k', { limit: 5, windowSeconds: 60 });

      expect(eval_).toHaveBeenCalledWith(expect.any(String), 1, 'k', '60000');
    });

    it('отбивает запрос сверх лимита и называет остаток срока', async () => {
      eval_.mockResolvedValue([4, 12_345]);

      await expect(service.hit('k', WINDOW)).resolves.toEqual({
        exceeded: true,
        retryAfterSeconds: 13,
        degraded: false,
      });
    });

    it('последний разрешённый запрос ещё проходит', async () => {
      eval_.mockResolvedValue([3, 100]);

      await expect(service.hit('k', WINDOW)).resolves.toMatchObject({ exceeded: false });
    });

    it('недоступный Redis пропускает запрос, а не отбивает его', async () => {
      // Решение пользователя (0040): лимит — второй рубеж поверх argon2id
      // и лимита сброса пароля в таблице, и падение кэша не должно
      // останавливать вход в CRM всему центру.
      eval_.mockRejectedValue(new Error('connect ECONNREFUSED'));

      await expect(service.hit('k', WINDOW)).resolves.toEqual({
        exceeded: false,
        retryAfterSeconds: 0,
        degraded: true,
      });
    });

    it('о неработающем лимите предупреждает в логе', async () => {
      eval_.mockRejectedValue(new Error('connect ECONNREFUSED'));

      await service.hit('k', WINDOW);

      expect(warn).toHaveBeenCalledWith(expect.stringContaining('ECONNREFUSED'));
    });

    it('но не заливает лог: жалоба не чаще раза в минуту', async () => {
      eval_.mockRejectedValue(new Error('нет соединения'));

      await service.hit('k', WINDOW);
      await service.hit('k', WINDOW);
      await service.hit('k', WINDOW);

      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('неожиданный ответ тоже пропускает запрос, а не открывает эндпоинт молча', async () => {
      // Number(undefined) — NaN, а NaN «не больше лимита»: без явной проверки
      // сломанный ответ снял бы лимит и никто бы этого не заметил.
      eval_.mockResolvedValue('внезапно строка');

      await expect(service.hit('k', WINDOW)).resolves.toMatchObject({ degraded: true });
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('нечисловое число обращений считается сбоем', async () => {
      eval_.mockResolvedValue([undefined, 100]);

      await expect(service.hit('k', WINDOW)).resolves.toMatchObject({
        exceeded: false,
        degraded: true,
      });
    });

    it('ответ строками (так отдаёт ioredis) разбирается правильно', async () => {
      eval_.mockResolvedValue(['4', '5000']);

      await expect(service.hit('k', WINDOW)).resolves.toMatchObject({
        exceeded: true,
        retryAfterSeconds: 5,
      });
    });
  });

  describe('без клиента Redis', () => {
    it('ничего не считает и пропускает запрос', async () => {
      // То же fail-open, только на этапе сборки модуля: считать негде.
      const withoutRedis = new RateLimitService();

      await expect(withoutRedis.hit('k', WINDOW)).resolves.toEqual({
        exceeded: false,
        retryAfterSeconds: 0,
        degraded: true,
      });
      await expect(withoutRedis.reset('k')).resolves.toBeUndefined();
    });

    it('предупреждает об этом при сборке — молча лимит не исчезает', () => {
      new RateLimitService();

      expect(warn).toHaveBeenCalledWith(expect.stringContaining('не действует'));
    });
  });

  describe('reset', () => {
    it('удаляет счётчик', async () => {
      del.mockResolvedValue(1);

      await service.reset('rl:auth.login:subject:abc');

      expect(del).toHaveBeenCalledWith('rl:auth.login:subject:abc');
    });

    it('сбой удаления наружу не бросает', async () => {
      del.mockRejectedValue(new Error('нет соединения'));

      await expect(service.reset('k')).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
    });
  });
});
