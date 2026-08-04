import { Logger } from '@nestjs/common';

import type { AppConfigService, SeedAdminEnv } from '../config';
import { AdminSeedBootstrap } from './admin-seed.bootstrap';
import type { AdminSeedService, SeedAdminResult } from './admin-seed.service';
import { AdminSeedError } from './admin-seed.service';

const FULL: SeedAdminEnv = {
  phone: '+992901234567',
  email: 'director@omuz.tj',
  firstName: 'Фаррух',
  lastName: 'Раҳимов',
  password: 'очень-секретный-пароль',
};

const RESULT: SeedAdminResult = {
  accountId: 'acc-1',
  employeeId: 'emp-1',
  phone: FULL.phone,
  email: FULL.email,
  accountCreated: true,
  roleAssigned: true,
};

const configOf = (over: Partial<AppConfigService> = {}): AppConfigService =>
  ({
    isTest: false,
    seedAdmin: FULL,
    seedAdminPartiallyConfigured: false,
    ...over,
  }) as AppConfigService;

describe('AdminSeedBootstrap', () => {
  let seed: jest.Mock<Promise<SeedAdminResult>, [SeedAdminEnv]>;
  let seeder: AdminSeedService;
  let log: jest.SpyInstance;
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;

  beforeEach(() => {
    seed = jest.fn().mockResolvedValue(RESULT);
    seeder = { seed } as unknown as AdminSeedService;

    log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('заводит руководителя, когда заданы все переменные', async () => {
    await new AdminSeedBootstrap(configOf(), seeder).onApplicationBootstrap();

    expect(seed).toHaveBeenCalledWith(FULL);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Заведён первый руководитель'));
  });

  it('без переменных не делает ничего и молчит', async () => {
    // Обычное состояние: на своей машине и в CI сид не настроен, и ругаться
    // на это было бы шумом в каждом запуске.
    await new AdminSeedBootstrap(
      configOf({ seedAdmin: null, seedAdminPartiallyConfigured: false }),
      seeder,
    ).onApplicationBootstrap();

    expect(seed).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('о наполовину заполненном наборе предупреждает', async () => {
    // Забытая переменная иначе оставила бы площадку без способа войти,
    // и понять это было бы не по чему.
    await new AdminSeedBootstrap(
      configOf({ seedAdmin: null, seedAdminPartiallyConfigured: true }),
      seeder,
    ).onApplicationBootstrap();

    expect(seed).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('SEED_ADMIN_'));
  });

  it('без пароля не заводит: показать сгенерированный было бы негде', async () => {
    await new AdminSeedBootstrap(
      configOf({ seedAdmin: { ...FULL, password: undefined } }),
      seeder,
    ).onApplicationBootstrap();

    expect(seed).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('SEED_ADMIN_PASSWORD'));
  });

  it('в тестовом окружении не работает', async () => {
    await new AdminSeedBootstrap(configOf({ isTest: true }), seeder).onApplicationBootstrap();

    expect(seed).not.toHaveBeenCalled();
  });

  it('существующий аккаунт не трогается, и это видно в логе', async () => {
    seed.mockResolvedValue({ ...RESULT, accountCreated: false, roleAssigned: false });

    await new AdminSeedBootstrap(configOf(), seeder).onApplicationBootstrap();

    expect(log).toHaveBeenCalledWith(expect.stringContaining('пароль не менялся'));
  });

  it('сбой сида не роняет приложение', async () => {
    // API работает и без руководителя, а упавший старт лечить труднее,
    // чем прочитать причину в логе.
    seed.mockRejectedValue(new AdminSeedError('Позиция Director не найдена'));

    await expect(
      new AdminSeedBootstrap(configOf(), seeder).onApplicationBootstrap(),
    ).resolves.toBeUndefined();

    expect(error).toHaveBeenCalledWith(expect.stringContaining('Позиция Director не найдена'));
  });

  it('неожиданная ошибка тоже не роняет приложение', async () => {
    seed.mockRejectedValue(new Error('база недоступна'));

    await expect(
      new AdminSeedBootstrap(configOf(), seeder).onApplicationBootstrap(),
    ).resolves.toBeUndefined();

    expect(error).toHaveBeenCalledWith(expect.stringContaining('база недоступна'));
  });

  it('пароль не попадает в лог ни при каком исходе', async () => {
    await new AdminSeedBootstrap(configOf(), seeder).onApplicationBootstrap();

    const written = [...log.mock.calls, ...warn.mock.calls, ...error.mock.calls].flat().join(' ');

    expect(written).not.toContain(FULL.password);
  });
});
