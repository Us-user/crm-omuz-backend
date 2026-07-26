import { PasswordService } from './password.service';

describe('PasswordService', () => {
  const service = new PasswordService();

  // argon2 намеренно медленный: 64 МиБ и 3 прохода на каждую операцию.
  jest.setTimeout(30_000);

  it('хеширует пароль алгоритмом argon2id (ТЗ 3.1)', async () => {
    const hash = await service.hash('очень-секретный-пароль');

    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(hash).not.toContain('очень-секретный-пароль');
  });

  it('даёт разные хеши для одного пароля — соль случайная', async () => {
    const [first, second] = await Promise.all([
      service.hash('одинаковый'),
      service.hash('одинаковый'),
    ]);

    expect(first).not.toBe(second);
  });

  it('подтверждает верный пароль и отклоняет неверный', async () => {
    const hash = await service.hash('правильный-пароль');

    await expect(service.verify(hash, 'правильный-пароль')).resolves.toBe(true);
    await expect(service.verify(hash, 'неправильный-пароль')).resolves.toBe(false);
  });

  it('на испорченном хеше возвращает false, а не бросает 500', async () => {
    await expect(service.verify('не-хеш-вовсе', 'пароль')).resolves.toBe(false);
    await expect(service.verify('', 'пароль')).resolves.toBe(false);
  });

  it('verifyDummy отрабатывает без ошибок — им выравнивается время ответа', async () => {
    await expect(service.verifyDummy('любой-пароль')).resolves.toBeUndefined();
  });
});
