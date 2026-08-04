import type { ExecutionContext } from '@nestjs/common';
import { HttpStatus, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { TooManyRequestsException } from '../common';
import type { AppConfigService } from '../config';
import { PhoneService } from '../phone';
import { RateLimit } from './decorators/rate-limit.decorator';
import type { RateLimitRule } from './rate-limit';
import { RateLimitGuard } from './rate-limit.guard';
import type { RateLimitService, RateLimitVerdict } from './rate-limit.service';

const IP_ONLY: RateLimitRule = {
  action: 'demo.ipOnly',
  ip: { limit: 3, windowSeconds: 60 },
};

const WITH_PHONE: RateLimitRule = {
  action: 'demo.login',
  ip: { limit: 3, windowSeconds: 60 },
  subject: { field: 'phone', kind: 'phone', limit: 2, windowSeconds: 900 },
};

const WITH_EMAIL: RateLimitRule = {
  action: 'demo.forgot',
  ip: { limit: 3, windowSeconds: 60 },
  subject: { field: 'email', kind: 'email', limit: 2, windowSeconds: 3600 },
};

/** Контроллер-образец: декораторы настоящие — значит, проверяются и они. */
class DemoController {
  @RateLimit(IP_ONLY)
  register(): void {}

  @RateLimit(WITH_PHONE)
  login(): void {}

  @RateLimit(WITH_EMAIL)
  forgot(): void {}

  /** Эндпоинт без лимита — guard на него не навешан, но метаданных нет и подавно. */
  logout(): void {}
}

interface FakeRequest {
  ip?: string;
  socket?: { remoteAddress?: string };
  body?: unknown;
}

class FakeResponse {
  readonly headers = new Map<string, string>();

  setHeader(name: string, value: string): void {
    this.headers.set(name, value);
  }
}

const contextOf = (
  handler: (...args: never[]) => unknown,
  request: FakeRequest,
  response: FakeResponse,
  type: 'http' | 'rpc' = 'http',
): ExecutionContext =>
  ({
    getType: () => type,
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
    getHandler: () => handler,
    getClass: () => DemoController,
  }) as unknown as ExecutionContext;

const allowed: RateLimitVerdict = { exceeded: false, retryAfterSeconds: 0, degraded: false };
const blocked = (retryAfterSeconds = 42): RateLimitVerdict => ({
  exceeded: true,
  retryAfterSeconds,
  degraded: false,
});

describe('RateLimitGuard', () => {
  const demo = new DemoController();
  let hit: jest.Mock<Promise<RateLimitVerdict>, [string, { limit: number }]>;
  let guard: RateLimitGuard;
  let response: FakeResponse;
  let enabled: boolean;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    enabled = true;
    hit = jest.fn().mockResolvedValue(allowed);
    response = new FakeResponse();

    const phones = new PhoneService({ defaultPhoneRegion: 'TJ' } as AppConfigService);
    const config = {
      get rateLimitEnabled(): boolean {
        return enabled;
      },
    } as AppConfigService;

    guard = new RateLimitGuard(
      new Reflector(),
      { hit } as unknown as RateLimitService,
      phones,
      config,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('эндпоинт без правила не считается вовсе', async () => {
    await expect(
      guard.canActivate(contextOf(demo.logout, { ip: '10.0.0.1' }, response)),
    ).resolves.toBe(true);

    expect(hit).not.toHaveBeenCalled();
  });

  it('считает обращение по адресу и пропускает, пока лимит не исчерпан', async () => {
    await expect(
      guard.canActivate(contextOf(demo.register, { ip: '203.0.113.7' }, response)),
    ).resolves.toBe(true);

    expect(hit).toHaveBeenCalledTimes(1);
    expect(hit).toHaveBeenCalledWith('rl:demo.ipOnly:ip:203.0.113.7', IP_ONLY.ip);
  });

  it('на исчерпанном лимите отвечает 429 и называет, когда повторить', async () => {
    hit.mockResolvedValue(blocked(17));

    await expect(
      guard.canActivate(contextOf(demo.register, { ip: '10.0.0.1' }, response)),
    ).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
      response: { code: 'TOO_MANY_REQUESTS', details: { retryAfterSeconds: 17 } },
    });
  });

  it('ставит заголовок Retry-After — его читают прокси и curl', async () => {
    hit.mockResolvedValue(blocked(17));

    await expect(
      guard.canActivate(contextOf(demo.register, { ip: '10.0.0.1' }, response)),
    ).rejects.toBeInstanceOf(TooManyRequestsException);

    expect(response.headers.get('Retry-After')).toBe('17');
  });

  it('выключенный лимит не обращается к счётчику', async () => {
    enabled = false;

    await expect(
      guard.canActivate(contextOf(demo.register, { ip: '10.0.0.1' }, response)),
    ).resolves.toBe(true);

    expect(hit).not.toHaveBeenCalled();
  });

  it('не-HTTP вызов (задача очереди) лимитом не ограничен', async () => {
    await expect(
      guard.canActivate(contextOf(demo.register, { ip: '10.0.0.1' }, response, 'rpc')),
    ).resolves.toBe(true);

    expect(hit).not.toHaveBeenCalled();
  });

  describe('второй счётчик — по логину', () => {
    it('считает и адрес, и номер', async () => {
      await guard.canActivate(
        contextOf(demo.login, { ip: '10.0.0.1', body: { phone: '+992901234567' } }, response),
      );

      expect(hit).toHaveBeenCalledTimes(2);
      expect(hit.mock.calls[0]?.[0]).toBe('rl:demo.login:ip:10.0.0.1');
      expect(hit.mock.calls[1]?.[0]).toMatch(/^rl:demo\.login:subject:[0-9a-f]{32}$/);
      expect(hit.mock.calls[1]?.[1]).toBe(WITH_PHONE.subject);
    });

    it('номер приводится к E.164 — лимит не обходится сменой формы записи', async () => {
      await guard.canActivate(
        contextOf(demo.login, { ip: '10.0.0.1', body: { phone: '901234567' } }, response),
      );
      await guard.canActivate(
        contextOf(demo.login, { ip: '10.0.0.1', body: { phone: '+992 90 123-45-67' } }, response),
      );

      expect(hit.mock.calls[1]?.[0]).toBe(hit.mock.calls[3]?.[0]);
    });

    it('почта приводится к нижнему регистру', async () => {
      await guard.canActivate(
        contextOf(demo.forgot, { ip: '10.0.0.1', body: { email: 'Farrukh@Example.TJ' } }, response),
      );
      await guard.canActivate(
        contextOf(demo.forgot, { ip: '10.0.0.1', body: { email: 'farrukh@example.tj' } }, response),
      );

      expect(hit.mock.calls[1]?.[0]).toBe(hit.mock.calls[3]?.[0]);
    });

    it('исчерпанный лимит по номеру отбивает запрос', async () => {
      hit.mockResolvedValueOnce(allowed).mockResolvedValueOnce(blocked(300));

      await expect(
        guard.canActivate(
          contextOf(demo.login, { ip: '10.0.0.1', body: { phone: '+992901234567' } }, response),
        ),
      ).rejects.toBeInstanceOf(TooManyRequestsException);

      expect(response.headers.get('Retry-After')).toBe('300');
    });

    it('исчерпанный лимит по адресу не накручивает счётчик номера', async () => {
      // Иначе перебор с одной машины закрывал бы вход тому, кого лимит защищает.
      hit.mockResolvedValue(blocked());

      await expect(
        guard.canActivate(
          contextOf(demo.login, { ip: '10.0.0.1', body: { phone: '+992901234567' } }, response),
        ),
      ).rejects.toBeInstanceOf(TooManyRequestsException);

      expect(hit).toHaveBeenCalledTimes(1);
    });

    it('неразбираемый номер считается как есть, а не роняет запрос 400-й', async () => {
      // 400 обязан прийти из ValidationPipe с внятным details, а не из лимитера;
      // но и мимо счёта такой запрос проходить не должен.
      await expect(
        guard.canActivate(
          contextOf(demo.login, { ip: '10.0.0.1', body: { phone: 'не телефон' } }, response),
        ),
      ).resolves.toBe(true);

      expect(hit).toHaveBeenCalledTimes(2);
    });

    it('без значения в теле остаётся один счётчик — по адресу', async () => {
      await guard.canActivate(contextOf(demo.login, { ip: '10.0.0.1', body: {} }, response));

      expect(hit).toHaveBeenCalledTimes(1);
    });

    it('тело не-объект второго счётчика не заводит', async () => {
      await guard.canActivate(contextOf(demo.login, { ip: '10.0.0.1', body: 'ерунда' }, response));

      expect(hit).toHaveBeenCalledTimes(1);
    });

    it('поле-объект вместо строки второго счётчика не заводит', async () => {
      await guard.canActivate(
        contextOf(demo.login, { ip: '10.0.0.1', body: { phone: { $ne: null } } }, response),
      );

      expect(hit).toHaveBeenCalledTimes(1);
    });
  });

  it('без адреса в запросе считает по метке «unknown», а не падает', async () => {
    await expect(guard.canActivate(contextOf(demo.register, {}, response))).resolves.toBe(true);

    expect(hit).toHaveBeenCalledWith('rl:demo.ipOnly:ip:unknown', IP_ONLY.ip);
  });

  it('IPv4 по IPv6-сокету не заводит второй счётчик тому же клиенту', async () => {
    await guard.canActivate(
      contextOf(demo.register, { socket: { remoteAddress: '::ffff:203.0.113.7' } }, response),
    );

    expect(hit).toHaveBeenCalledWith('rl:demo.ipOnly:ip:203.0.113.7', IP_ONLY.ip);
  });
});
