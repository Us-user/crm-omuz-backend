import { AccountType } from '@prisma/client';

import { PasswordService } from '../auth';
import type { AppConfigService } from '../config';
import { PhoneService } from '../phone';
import type { AdminSeedRepository, ExistingAccount } from './admin-seed.repository';
import { AdminSeedError, AdminSeedService } from './admin-seed.service';

const DIRECTOR_POSITION_ID = '11111111-1111-1111-1111-111111111111';
const ACCOUNT_ID = '22222222-2222-2222-2222-222222222222';
const EMPLOYEE_ID = '33333333-3333-3333-3333-333333333333';

const input = {
  phone: '901234567',
  email: 'Director@Omuz.TJ',
  firstName: 'Фаррух',
  lastName: 'Раҳимов',
  password: 'super-secret-1',
};

const existingEmployee = (positionIds: string[] = []): ExistingAccount => ({
  id: ACCOUNT_ID,
  phone: '+992901234567',
  email: 'director@omuz.tj',
  type: AccountType.EMPLOYEE,
  employee: { id: EMPLOYEE_ID, positionIds },
});

describe('AdminSeedService', () => {
  let repository: jest.Mocked<
    Pick<
      AdminSeedRepository,
      | 'findAccountByPhone'
      | 'findAccountIdByEmail'
      | 'findPositionByName'
      | 'findEmployeeIdByPhone'
      | 'createDirector'
      | 'assignPosition'
    >
  >;
  let service: AdminSeedService;

  beforeEach(() => {
    repository = {
      findAccountByPhone: jest.fn().mockResolvedValue(null),
      findAccountIdByEmail: jest.fn().mockResolvedValue(null),
      findPositionByName: jest.fn().mockResolvedValue({ id: DIRECTOR_POSITION_ID }),
      findEmployeeIdByPhone: jest.fn().mockResolvedValue(null),
      createDirector: jest
        .fn()
        .mockResolvedValue({ accountId: ACCOUNT_ID, employeeId: EMPLOYEE_ID }),
      assignPosition: jest.fn().mockResolvedValue(undefined),
    };

    const phones = new PhoneService({ defaultPhoneRegion: 'TJ' } as AppConfigService);
    service = new AdminSeedService(
      repository as unknown as AdminSeedRepository,
      new PasswordService(),
      phones,
    );
  });

  describe('Пустая база', () => {
    it('создаёт аккаунт сотрудника с позицией Director', async () => {
      const result = await service.seed(input);

      expect(result).toMatchObject({
        accountId: ACCOUNT_ID,
        employeeId: EMPLOYEE_ID,
        accountCreated: true,
        roleAssigned: true,
      });
      expect(repository.createDirector).toHaveBeenCalledWith(
        expect.objectContaining({ positionId: DIRECTOR_POSITION_ID }),
      );
    });

    it('нормализует телефон в E.164 и email в нижний регистр', async () => {
      const result = await service.seed(input);

      expect(result.phone).toBe('+992901234567');
      expect(result.email).toBe('director@omuz.tj');
      expect(repository.createDirector).toHaveBeenCalledWith(
        expect.objectContaining({ phone: '+992901234567', email: 'director@omuz.tj' }),
      );
    });

    it('пароль хранится argon2id-хешем, а не открытым текстом', async () => {
      await service.seed(input);

      const { passwordHash } = repository.createDirector.mock.calls[0]?.[0] ?? {
        passwordHash: '',
      };
      expect(passwordHash.startsWith('$argon2id$')).toBe(true);
      expect(passwordHash).not.toContain(input.password);
    });

    it('без пароля генерирует его и возвращает ровно один раз', async () => {
      const withoutPassword = { ...input, password: undefined };

      const result = await service.seed(withoutPassword);

      expect(result.generatedPassword).toEqual(expect.any(String));
      expect((result.generatedPassword ?? '').length).toBeGreaterThanOrEqual(8);
    });

    it('заданный пароль в ответе не возвращается', async () => {
      const result = await service.seed(input);

      expect(result.generatedPassword).toBeUndefined();
    });

    it('короткий пароль отвергается до записи (ТЗ 3.1: ≥8 символов)', async () => {
      await expect(service.seed({ ...input, password: 'short' })).rejects.toBeInstanceOf(
        AdminSeedError,
      );
      expect(repository.createDirector).not.toHaveBeenCalled();
    });

    it('занятый email отвергается до записи', async () => {
      repository.findAccountIdByEmail.mockResolvedValue({ id: 'other' });

      await expect(service.seed(input)).rejects.toBeInstanceOf(AdminSeedError);
      expect(repository.createDirector).not.toHaveBeenCalled();
    });

    it('телефон, занятый профилем другого сотрудника, отвергается до записи', async () => {
      repository.findEmployeeIdByPhone.mockResolvedValue({ id: 'other' });

      await expect(service.seed(input)).rejects.toBeInstanceOf(AdminSeedError);
      expect(repository.createDirector).not.toHaveBeenCalled();
    });

    it('некорректный телефон отвергается', async () => {
      await expect(service.seed({ ...input, phone: '12' })).rejects.toThrow();
    });
  });

  describe('Повторный запуск', () => {
    it('существующему сотруднику досогласовывает позицию, не трогая пароль', async () => {
      repository.findAccountByPhone.mockResolvedValue(existingEmployee());

      const result = await service.seed(input);

      expect(result).toMatchObject({ accountCreated: false, roleAssigned: true });
      expect(repository.assignPosition).toHaveBeenCalledWith(EMPLOYEE_ID, DIRECTOR_POSITION_ID);
      expect(repository.createDirector).not.toHaveBeenCalled();
    });

    it('если позиция уже есть — не пишет в базу вообще', async () => {
      repository.findAccountByPhone.mockResolvedValue(existingEmployee([DIRECTOR_POSITION_ID]));

      const result = await service.seed(input);

      expect(result).toMatchObject({ accountCreated: false, roleAssigned: false });
      expect(repository.assignPosition).not.toHaveBeenCalled();
    });

    it('телефон, занятый студентом, не перехватывается', async () => {
      repository.findAccountByPhone.mockResolvedValue({
        id: ACCOUNT_ID,
        phone: '+992901234567',
        email: 'student@omuz.tj',
        type: AccountType.STUDENT,
        employee: null,
      });

      await expect(service.seed(input)).rejects.toBeInstanceOf(AdminSeedError);
      expect(repository.assignPosition).not.toHaveBeenCalled();
      expect(repository.createDirector).not.toHaveBeenCalled();
    });
  });

  describe('Не применены миграции', () => {
    it('отсутствие позиции Director объясняется, а не падает ошибкой БД', async () => {
      repository.findPositionByName.mockResolvedValue(null);

      const error = await service.seed(input).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AdminSeedError);
      expect((error as Error).message).toContain('prisma:deploy');
    });
  });
});
