import {
  clientIpOf,
  hashSubject,
  ipRateLimitKey,
  isExceeded,
  normalizeIp,
  retryAfterSeconds,
  subjectRateLimitKey,
  subjectValueOf,
} from './rate-limit';

describe('ipRateLimitKey / subjectRateLimitKey', () => {
  it('разводит счётчики разных эндпоинтов', () => {
    expect(ipRateLimitKey('auth.login', '10.0.0.1')).not.toBe(
      ipRateLimitKey('auth.register', '10.0.0.1'),
    );
  });

  it('разводит счётчики по адресу и по логину', () => {
    expect(ipRateLimitKey('auth.login', 'x')).not.toBe(subjectRateLimitKey('auth.login', 'x'));
  });

  it('адрес в ключе виден открытым — по нему разбирают инцидент', () => {
    expect(ipRateLimitKey('auth.login', '203.0.113.7')).toBe('rl:auth.login:ip:203.0.113.7');
  });

  it('логин в ключ открытым текстом не попадает', () => {
    const key = subjectRateLimitKey('auth.password.forgot', 'farrukh@example.tj');

    expect(key).not.toContain('farrukh');
    expect(key).not.toContain('@');
    expect(key).toMatch(/^rl:auth\.password\.forgot:subject:[0-9a-f]{32}$/);
  });

  it('один логин даёт один ключ, разные — разные', () => {
    expect(subjectRateLimitKey('a', '+992901234567')).toBe(
      subjectRateLimitKey('a', '+992901234567'),
    );
    expect(subjectRateLimitKey('a', '+992901234567')).not.toBe(
      subjectRateLimitKey('a', '+992901234568'),
    );
  });
});

describe('hashSubject', () => {
  it('даёт 128 бит в шестнадцатеричной записи', () => {
    expect(hashSubject('что угодно')).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('normalizeIp', () => {
  it('разворачивает IPv4, пришедший по IPv6-сокету', () => {
    // Иначе один клиент получил бы два счётчика — по одному на форму записи.
    expect(normalizeIp('::ffff:203.0.113.7')).toBe('203.0.113.7');
  });

  it('оставляет обычный IPv4 как есть', () => {
    expect(normalizeIp('203.0.113.7')).toBe('203.0.113.7');
  });

  it('приводит IPv6 к нижнему регистру', () => {
    expect(normalizeIp('2001:DB8::1')).toBe('2001:db8::1');
  });

  it('обрезает пробелы', () => {
    expect(normalizeIp('  10.0.0.1  ')).toBe('10.0.0.1');
  });

  it('без адреса даёт «unknown», а не пустую строку', () => {
    // Пустая строка склеила бы ключ и посчитала бы всех безадресных вместе
    // с соседним ключом; явная метка это делает видимым.
    expect(normalizeIp(undefined)).toBe('unknown');
    expect(normalizeIp(null)).toBe('unknown');
    expect(normalizeIp('   ')).toBe('unknown');
  });
});

describe('clientIpOf', () => {
  it('берёт разобранный express-ом адрес', () => {
    expect(clientIpOf({ ip: '203.0.113.7', socket: { remoteAddress: '10.0.0.1' } })).toBe(
      '203.0.113.7',
    );
  });

  it('без него откатывается к адресу сокета', () => {
    expect(clientIpOf({ socket: { remoteAddress: '::ffff:10.0.0.1' } })).toBe('10.0.0.1');
  });

  it('без обоих — «unknown»', () => {
    expect(clientIpOf({})).toBe('unknown');
  });
});

describe('subjectValueOf', () => {
  it('берёт значение поля и обрезает пробелы', () => {
    expect(subjectValueOf({ email: '  Farrukh@Example.TJ ' }, 'email')).toBe('Farrukh@Example.TJ');
  });

  it('пустое значение не годится в ключ', () => {
    expect(subjectValueOf({ phone: '   ' }, 'phone')).toBeNull();
    expect(subjectValueOf({ phone: '' }, 'phone')).toBeNull();
  });

  it('отсутствующее поле даёт null', () => {
    expect(subjectValueOf({ email: 'a@b.tj' }, 'phone')).toBeNull();
  });

  it('не-строка даёт null', () => {
    // Guard стоит **до** ValidationPipe, поэтому тело бывает каким угодно:
    // объект вместо строки не должен превращаться в «[object Object]»-ключ.
    expect(subjectValueOf({ phone: { $ne: null } }, 'phone')).toBeNull();
    expect(subjectValueOf({ phone: 42 }, 'phone')).toBeNull();
    expect(subjectValueOf({ phone: ['a'] }, 'phone')).toBeNull();
  });

  it('тело не-объект даёт null', () => {
    expect(subjectValueOf(undefined, 'phone')).toBeNull();
    expect(subjectValueOf(null, 'phone')).toBeNull();
    expect(subjectValueOf('строка', 'phone')).toBeNull();
  });

  it('запредельно длинное значение отбрасывается', () => {
    expect(subjectValueOf({ email: 'x'.repeat(255) }, 'email')).toBeNull();
    expect(subjectValueOf({ email: 'x'.repeat(254) }, 'email')).toHaveLength(254);
  });
});

describe('retryAfterSeconds', () => {
  it('округляет остаток срока вверх', () => {
    expect(retryAfterSeconds(1500, 60)).toBe(2);
    expect(retryAfterSeconds(60_000, 3600)).toBe(60);
  });

  it('никогда не обещает «через ноль секунд»', () => {
    expect(retryAfterSeconds(1, 60)).toBe(1);
  });

  it('у ключа без срока и у исчезнувшего называет полное окно', () => {
    // PTTL отдаёт -1 и -2; «через секунду» было бы неправдой.
    expect(retryAfterSeconds(-1, 900)).toBe(900);
    expect(retryAfterSeconds(-2, 900)).toBe(900);
    expect(retryAfterSeconds(0, 900)).toBe(900);
  });

  it('нечисло не превращается в NaN', () => {
    expect(retryAfterSeconds(Number.NaN, 300)).toBe(300);
  });
});

describe('isExceeded', () => {
  it('пропускает ровно столько запросов, сколько разрешено', () => {
    // INCR возвращает 1 на первом запросе: при лимите 3 проходят 1–3.
    expect(isExceeded(1, 3)).toBe(false);
    expect(isExceeded(3, 3)).toBe(false);
    expect(isExceeded(4, 3)).toBe(true);
  });
});
