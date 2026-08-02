import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AccountStatus, EmployeeStatus } from '@prisma/client';

import {
  BusinessRuleException,
  emptyToNull,
  emptyToNullPatch,
  formatIsoDate,
  Paginated,
  parseIsoDate,
} from '../common';
import { PhoneService } from '../phone';
// Прямыми путями, а не через barrel `../rbac`: оттуда пришли бы ещё репозитории
// и сервисы администрирования прав, которые сотрудникам не нужны (правило сессии 0007).
import { PermissionsService } from '../rbac/permissions.service';
import { DIRECTOR_POSITION_NAME } from '../rbac/rbac.constants';
import type {
  CreateEmployeeDto,
  EmployeeDeletedDto,
  EmployeeDto,
  EmployeeQueryDto,
  UpdateEmployeeDto,
} from './dto';
import type { EmployeeDeletionCheck, EmployeeRow, PositionRow } from './employees.repository';
import { EmployeesRepository } from './employees.repository';

/**
 * Право, без которого позиции в форме сотрудника не принимаются (решение
 * этой сессии, вынесено пользователю).
 *
 * ТЗ 5.14 перечисляет «Position (мультивыбор)» полем формы, но позиция — это
 * роль доступа (ТЗ 3.2), и назначение ролей ТЗ 5.15 закрывает **своим** правом.
 * Приняв позиции под `Permission.Employees.Update`, мы сделали бы право на правку
 * карточки правом раздать себе `Director` вместе с бухгалтерией (ТЗ 5.16).
 * Поэтому поле требует обоих прав, а форма без позиций — только права на карточку.
 */
const MANAGE_ROLES = 'Permission.Administration.ManageUserRoles' as const;

/** Кем сотрудник станет после операции — из этого выводится правило про `Director`. */
interface EmployeeAfter {
  positionIds?: readonly string[];
  status?: EmployeeStatus;
  deleted?: boolean;
}

/** Позиции сотрудника в том виде, в каком их отдают обе выборки репозитория. */
type HeldPositions = readonly { position: PositionRow }[];

/**
 * Сотрудники (ТЗ 5.14) — список, карточка и форма «Employer».
 *
 * Правила модуля:
 *   - телефон уникален среди сотрудников (409): он же становится логином
 *     при выдаче аккаунта, и второй профиль с тем же номером сделал бы вход
 *     неоднозначным;
 *   - филиал из тела должен существовать (422, а не 404: ресурс из пути найден,
 *     не найдено то, что пришло в теле — как в группах и аудиториях);
 *   - **`INACTIVE` закрывает вход** (решение этой сессии): «выведен из штата»
 *     и «может войти со всеми правами своих позиций» — состояния, которые
 *     не должны существовать одновременно;
 *   - **последний действующий `Director` неприкосновенен**: его нельзя ни
 *     разжаловать, ни уволить, ни удалить — администрировать систему станет
 *     некому, а вернуть доступ можно будет только правкой БД;
 *   - профиль со следами работы не удаляется (409): вместе с ним пропало бы,
 *     кто вёл группу и кто закрывал недели журнала.
 *
 * Аккаунт здесь не создаётся: ТЗ 5.14 называет логин опциональным. Он появляется
 * переводом студента (ТЗ 3.1) или сид-скриптом; при удалении профиля — уходит
 * вместе с ним, потому что логина без профиля ТЗ 3.1 не допускает.
 */
@Injectable()
export class EmployeesService {
  private readonly logger = new Logger(EmployeesService.name);

  constructor(
    private readonly repository: EmployeesRepository,
    private readonly phones: PhoneService,
    private readonly permissions: PermissionsService,
  ) {}

  async findAll(query: EmployeeQueryDto): Promise<Paginated<EmployeeDto>> {
    const { rows, total } = await this.repository.findMany({
      search: query.search,
      status: query.status,
      branchId: query.branchId,
      positionId: query.positionId,
      hasAccount: query.hasAccount,
      sort: query.sort,
      order: query.order,
      skip: query.skip,
      take: query.take,
    });

    return Paginated.from(rows.map(toDto), total, query);
  }

  async findOne(id: string): Promise<EmployeeDto> {
    return toDto(await this.require(id));
  }

  async create(dto: CreateEmployeeDto, actorAccountId: string): Promise<EmployeeDto> {
    const phone = this.phones.normalize(dto.phone, 'phone');
    await this.assertPhoneFree(phone);

    const branchId = emptyToNull(dto.branchId);
    if (branchId !== null) await this.assertBranchExists(branchId);

    const positionIds = await this.resolvePositions(dto.positionIds, actorAccountId);

    const employee = await this.repository.create(
      {
        firstName: dto.firstName,
        lastName: dto.lastName,
        middleName: emptyToNull(dto.middleName),
        phone,
        birthDate: parseOptionalDate(dto.birthDate, 'birthDate'),
        gender: dto.gender ?? null,
        address: emptyToNull(dto.address),
        email: emptyToNull(dto.email),
        telegram: emptyToNull(dto.telegram),
        photoUrl: emptyToNull(dto.photoUrl),
        experience: emptyToNull(dto.experience),
        description: emptyToNull(dto.description),
        branchId,
        hiredAt: parseOptionalDate(dto.hiredAt, 'hiredAt'),
        status: dto.status,
      },
      positionIds,
    );

    this.logger.log(`Создан сотрудник ${employee.lastName} ${employee.firstName} (${employee.id})`);

    // Согласовывать статус аккаунта не с чем: свежий профиль заводится без
    // логина (ТЗ 5.14), а `INACTIVE` закрывает именно вход.
    return toDto(employee);
  }

  async update(id: string, dto: UpdateEmployeeDto, actorAccountId: string): Promise<EmployeeDto> {
    const current = await this.require(id);

    // Телефон обязателен и очистке не подлежит: пустая строка не пройдёт
    // разбор и вернётся честным 400, а не молча оставит прежний номер.
    const phone = dto.phone === undefined ? undefined : this.phones.normalize(dto.phone, 'phone');
    if (phone !== undefined) await this.assertPhoneFree(phone, id);

    const branchId = emptyToNullPatch(dto.branchId);
    if (branchId !== undefined && branchId !== null) await this.assertBranchExists(branchId);

    const positionIds = await this.resolvePositions(dto.positionIds, actorAccountId);

    await this.assertDirectorSurvives(current, { positionIds, status: dto.status });

    const { employee, revokedSessions } = await this.repository.update(
      id,
      {
        firstName: dto.firstName,
        lastName: dto.lastName,
        middleName: emptyToNullPatch(dto.middleName),
        phone,
        birthDate: parseOptionalDatePatch(dto.birthDate, 'birthDate'),
        gender: dto.gender,
        address: emptyToNullPatch(dto.address),
        email: emptyToNullPatch(dto.email),
        telegram: emptyToNullPatch(dto.telegram),
        photoUrl: emptyToNullPatch(dto.photoUrl),
        experience: emptyToNullPatch(dto.experience),
        description: emptyToNullPatch(dto.description),
        branchId,
        hiredAt: parseOptionalDatePatch(dto.hiredAt, 'hiredAt'),
        status: dto.status,
      },
      positionIds,
      accountStatusFor(current.status, dto.status),
    );

    this.logger.log(
      `Изменён сотрудник ${employee.lastName} ${employee.firstName} (${employee.id})` +
        (revokedSessions > 0 ? `; погашено сессий: ${String(revokedSessions)}` : ''),
    );

    return toDto(employee);
  }

  async remove(id: string): Promise<EmployeeDeletedDto> {
    const employee = await this.repository.findForDeletion(id);
    if (!employee) {
      throw new NotFoundException('Сотрудник не найден');
    }

    this.assertDeletable(employee);
    await this.assertDirectorSurvives(employee, { deleted: true });

    await this.repository.delete(id, employee.accountId);

    const fullName = `${employee.lastName} ${employee.firstName}`;
    this.logger.log(
      `Удалён сотрудник ${fullName} (${id})` +
        (employee.accountId === null ? '' : ' вместе с его аккаунтом'),
    );

    return { id, fullName, accountDeleted: employee.accountId !== null };
  }

  /**
   * Позиции из тела запроса: проверка права и существования.
   *
   * Право спрашивается **до** обращения к БД и только когда поле передано:
   * форма без мультивыбора — обычная правка карточки, и требовать за неё право
   * администрирования значило бы закрыть карточку сотрудника всем, кроме
   * администраторов прав.
   *
   * Несуществующая позиция — 422 с перечислением **только недостающих**:
   * оператору нужно знать, что поправить, а не читать свой же запрос обратно
   * (то же правило, что в «Show to group» сессии 0009 и в назначении ролей 0006).
   */
  private async resolvePositions(
    positionIds: string[] | undefined,
    actorAccountId: string,
  ): Promise<readonly string[] | undefined> {
    if (positionIds === undefined) return undefined;

    if (!(await this.permissions.hasPermissions(actorAccountId, [MANAGE_ROLES]))) {
      throw new ForbiddenException(
        'Позиции сотрудника — это его роли доступа (ТЗ 3.2): для их изменения нужно право ' +
          `${MANAGE_ROLES}. Уберите positionIds из запроса или назначьте роли через ` +
          '/admin/users/{accountId}/roles',
      );
    }

    const found = await this.repository.findPositionsByIds(positionIds);
    if (found.length !== positionIds.length) {
      const known = new Set(found.map(({ id }) => id));
      throw new BusinessRuleException(
        'Часть позиций не найдена',
        positionIds.filter((id) => !known.has(id)),
      );
    }

    return positionIds;
  }

  private async require(id: string): Promise<EmployeeRow> {
    const employee = await this.repository.findById(id);
    if (!employee) {
      throw new NotFoundException('Сотрудник не найден');
    }

    return employee;
  }

  private async assertPhoneFree(phone: string, exceptId?: string): Promise<void> {
    const twin = await this.repository.findByPhone(phone);
    if (twin && twin.id !== exceptId) {
      throw new ConflictException(
        `Телефон ${phone} уже записан за сотрудником ${twin.lastName} ${twin.firstName}`,
      );
    }
  }

  private async assertBranchExists(branchId: string): Promise<void> {
    const branch = await this.repository.findBranch(branchId);
    if (!branch) {
      throw new BusinessRuleException('Филиал не найден', { branchId });
    }
  }

  /**
   * В системе обязан остаться хотя бы один **действующий** сотрудник с позицией
   * `Director` (ТЗ 3.2, 5.16). Сессия 0006 завела это правило для снятия роли;
   * здесь оно закрывает ещё два пути к тому же состоянию — увольнение и удаление.
   *
   * Все три ведут к одному: бухгалтерия доступна только `Director` (ТЗ 5.16),
   * а вернуть позицию мог бы лишь тот, у кого есть право назначать роли.
   * Уволенный руководитель в счёт не идёт: вход ему закрыт тем же решением
   * этой сессии, и «Director на бумаге» систему не разблокирует.
   */
  private async assertDirectorSurvives(
    employee: { id: string; status: EmployeeStatus; positions: HeldPositions },
    after: EmployeeAfter,
  ): Promise<void> {
    const director = employee.positions.find(
      ({ position }) => position.isSystem && position.name === DIRECTOR_POSITION_NAME,
    )?.position;

    // Сейчас за руководителя он не считается — забирать нечего.
    if (!director || employee.status !== EmployeeStatus.ACTIVE) return;

    const keepsPosition =
      after.deleted !== true &&
      (after.positionIds === undefined || after.positionIds.includes(director.id));
    const staysActive =
      after.deleted !== true && (after.status ?? employee.status) === EmployeeStatus.ACTIVE;

    if (keepsPosition && staysActive) return;

    const others = await this.repository.countPositionHolders(director.id, employee.id);
    if (others === 0) {
      throw new BusinessRuleException(
        `Это последний действующий сотрудник с позицией ${DIRECTOR_POSITION_NAME}: ` +
          'снять её, вывести его из штата или удалить нельзя — администрировать систему ' +
          'станет некому. Сначала назначьте руководителя другому сотруднику',
      );
    }
  }

  /**
   * Профиль удаляется только «чистым». Причина не в целостности — менторство
   * каскадное, а остальные ссылки обнуляются, и БД такое удаление пропустит, —
   * а в данных: вместе со строкой сотрудника исчезло бы, кто вёл группу (ТЗ 5.5),
   * а недели журнала (ТЗ 5.8), заметки о студентах (ТЗ 5.3) и начисленные коины
   * (ТЗ 5.9) остались бы без автора. Восстановить это неоткуда.
   *
   * Для «человек больше не работает» есть статус `INACTIVE` — он и закрывает вход.
   * То же решение, что у филиала с записями (0007), группы с составом (0012)
   * и студента с учебной историей (0014).
   */
  private assertDeletable(employee: EmployeeDeletionCheck): void {
    const held: readonly [string, number][] = [
      ['группы под менторством', employee._count.mentorGroups],
      ['занятия в расписании', employee._count.mentorSlots],
      ['финализированные недели журнала', employee._count.submittedWeeks],
      ['заметки о студентах', employee._count.authoredFeedback],
      ['начисления коинов', employee._count.awardedCoins],
      // Часы зарплаты считаются по проведённым занятиям (ТЗ 5.16, 0032):
      // удаление профиля обнулило бы ведущего у дней журнала (`SET NULL`),
      // и прошлые ведомости молча перестали бы сходиться.
      ['проведённые занятия', employee._count.taughtDays],
      ['расчёты зарплаты', employee._count.salaries],
    ];

    const blocking = held.filter(([, count]) => count > 0);
    if (blocking.length > 0) {
      throw new ConflictException(
        `У сотрудника есть история работы: ${blocking
          .map(([label, count]) => `${label} (${String(count)})`)
          .join(', ')} — переведите его в статус «INACTIVE» вместо удаления`,
      );
    }
  }
}

/**
 * Статус аккаунта, вытекающий из смены штатного статуса (решение этой сессии).
 *
 * `undefined` — вход не трогаем: статус не передан или не изменился. Повторная
 * установка того же значения не гасит сессии заново, в отличие от блокировки
 * студента (сессия 0015): там `POST /block` — прямая просьба «выгони его
 * отовсюду», а здесь это правка формы, и лишнее гашение сессий стало бы
 * побочным эффектом сохранения карточки без изменений.
 */
const accountStatusFor = (
  current: EmployeeStatus,
  next: EmployeeStatus | undefined,
): AccountStatus | undefined => {
  if (next === undefined || next === current) return undefined;

  return next === EmployeeStatus.INACTIVE ? AccountStatus.BLOCKED : AccountStatus.ACTIVE;
};

const parseOptionalDate = (value: string | undefined, field: string): Date | null =>
  value === undefined || value === '' ? null : parseIsoDate(value, field);

const parseOptionalDatePatch = (
  value: string | undefined,
  field: string,
): Date | null | undefined => (value === undefined ? undefined : parseOptionalDate(value, field));

const toDto = (row: EmployeeRow): EmployeeDto => ({
  id: row.id,
  firstName: row.firstName,
  lastName: row.lastName,
  middleName: row.middleName,
  phone: row.phone,
  birthDate: row.birthDate === null ? null : formatIsoDate(row.birthDate),
  gender: row.gender,
  address: row.address,
  email: row.email,
  telegram: row.telegram,
  photoUrl: row.photoUrl,
  experience: row.experience,
  description: row.description,
  branch: row.branch,
  status: row.status,
  hiredAt: row.hiredAt === null ? null : formatIsoDate(row.hiredAt),
  account: row.account,
  positions: row.positions.map(({ position }) => position),
  groups: row.mentorGroups.map(({ group, role }) => ({
    id: group.id,
    name: group.name,
    courseId: group.courseId,
    courseTitle: group.course.title,
    role,
  })),
  formerStudentId: row.formerStudentId,
  createdAt: row.createdAt.toISOString(),
});
