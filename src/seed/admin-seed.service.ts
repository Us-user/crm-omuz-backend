import { randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { AccountType } from '@prisma/client';

import { PasswordService } from '../auth';
import { PhoneService } from '../phone';
import { DIRECTOR_POSITION_NAME } from '../rbac';
import { AdminSeedRepository } from './admin-seed.repository';

/** Минимальная длина пароля — та же, что при регистрации (ТЗ 3.1). */
export const MIN_ADMIN_PASSWORD_LENGTH = 8;

export interface SeedAdminInput {
  phone: string;
  email: string;
  /** Не задан — сгенерируем и покажем один раз. */
  password?: string;
  firstName: string;
  lastName: string;
  middleName?: string;
}

export interface SeedAdminResult {
  accountId: string;
  employeeId: string;
  phone: string;
  email: string;
  /** `false` — аккаунт уже существовал, пароль не трогали. */
  accountCreated: boolean;
  /** `false` — позиция `Director` у него уже была. */
  roleAssigned: boolean;
  /** Заполнен, только если пароль сгенерирован здесь. */
  generatedPassword?: string;
}

/** Отказ сида — отдельный тип: у скрипта нет HTTP-кодов, ему нужен текст причины. */
export class AdminSeedError extends Error {}

/**
 * Заведение первого руководителя (`npm run seed:admin`).
 *
 * Зачем это существует: система закрыта сама на себя. Регистрация создаёт только
 * студентов (ТЗ 5.14: сотрудников заводит администратор), перевод в сотрудники
 * требует права `Permission.Students.Promote`, а назначение ролей — права
 * `Permission.Administration.ManageUserRoles`. На пустой базе выдать первое право
 * некому, и без этого скрипта система недоступна вообще никому.
 *
 * Почему скрипт, а не эндпоинт «первичной настройки»: публичный путь к правам
 * `Director` пришлось бы охранять и он остался бы в приложении навсегда, хотя
 * нужен ровно один раз. Скрипт запускается тем, у кого уже есть доступ к серверу
 * и к базе, то есть новых возможностей никому не даёт.
 *
 * Повторный запуск безопасен: существующий аккаунт не трогается (пароль в том
 * числе), недостающая позиция `Director` просто досогласовывается.
 */
@Injectable()
export class AdminSeedService {
  constructor(
    private readonly repository: AdminSeedRepository,
    private readonly passwords: PasswordService,
    private readonly phones: PhoneService,
  ) {}

  async seed(input: SeedAdminInput): Promise<SeedAdminResult> {
    const phone = this.phones.normalize(input.phone, 'phone');
    const email = input.email.trim().toLowerCase();

    const position = await this.repository.findPositionByName(DIRECTOR_POSITION_NAME);
    if (!position) {
      // Позицию заводит миграция и восстанавливает синхронизация каталога при
      // старте. Её отсутствие означает, что миграции не применены.
      throw new AdminSeedError(
        `Позиция ${DIRECTOR_POSITION_NAME} не найдена — примените миграции: npm run prisma:deploy`,
      );
    }

    const existing = await this.repository.findAccountByPhone(phone);
    if (existing) {
      return this.attachToExisting(existing, position.id);
    }

    return this.createNew({ ...input, phone, email }, position.id);
  }

  /**
   * Аккаунт с таким логином уже есть. Пароль и профиль не трогаем — скрипт
   * не должен уметь перехватывать чужой аккаунт; максимум, что он делает, —
   * досогласовывает позицию `Director`.
   */
  private async attachToExisting(
    existing: NonNullable<Awaited<ReturnType<AdminSeedRepository['findAccountByPhone']>>>,
    positionId: string,
  ): Promise<SeedAdminResult> {
    if (existing.type !== AccountType.EMPLOYEE || !existing.employee) {
      throw new AdminSeedError(
        `Телефон ${existing.phone} занят аккаунтом студента — укажите другой номер ` +
          'или переведите студента в сотрудники',
      );
    }

    const alreadyDirector = existing.employee.positionIds.includes(positionId);
    if (!alreadyDirector) {
      await this.repository.assignPosition(existing.employee.id, positionId);
    }

    return {
      accountId: existing.id,
      employeeId: existing.employee.id,
      phone: existing.phone,
      email: existing.email,
      accountCreated: false,
      roleAssigned: !alreadyDirector,
    };
  }

  private async createNew(
    input: SeedAdminInput & { phone: string; email: string },
    positionId: string,
  ): Promise<SeedAdminResult> {
    const emailOwner = await this.repository.findAccountIdByEmail(input.email);
    if (emailOwner) {
      throw new AdminSeedError(`Email ${input.email} уже занят другим аккаунтом`);
    }

    // Профиль сотрудника хранит контактный телефон отдельно от логина, и он тоже
    // уникален: без явной проверки вставка упала бы ошибкой уникального индекса.
    const phoneOwner = await this.repository.findEmployeeIdByPhone(input.phone);
    if (phoneOwner) {
      throw new AdminSeedError(
        `Телефон ${input.phone} уже указан у другого сотрудника — укажите другой номер`,
      );
    }

    const generated = input.password === undefined ? generatePassword() : undefined;
    const password = input.password ?? generated;
    if (password === undefined || password.length < MIN_ADMIN_PASSWORD_LENGTH) {
      throw new AdminSeedError(
        `Пароль должен быть не короче ${String(MIN_ADMIN_PASSWORD_LENGTH)} символов`,
      );
    }

    const created = await this.repository.createDirector({
      phone: input.phone,
      email: input.email,
      passwordHash: await this.passwords.hash(password),
      firstName: input.firstName,
      lastName: input.lastName,
      middleName: input.middleName ?? null,
      positionId,
    });

    return {
      ...created,
      phone: input.phone,
      email: input.email,
      accountCreated: true,
      roleAssigned: true,
      generatedPassword: generated,
    };
  }
}

/**
 * Пароль, когда его не задали: 24 случайных байта в base64url. Так у скрипта
 * есть безопасный режим «без пароля в истории команд» — значение показывается
 * один раз в выводе и нигде не сохраняется.
 */
const generatePassword = (): string => randomBytes(18).toString('base64url');
