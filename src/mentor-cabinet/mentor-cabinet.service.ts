import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { EmployeeStatus } from '@prisma/client';

import { AvansService } from '../avans/avans.service';
import type {
  AvansQueryDto,
  AvansRequestCancelledDto,
  AvansRequestDto,
  CreateAvansRequestDto,
} from '../avans/dto';
import {
  BusinessRuleException,
  formatDayTime,
  formatIsoDate,
  formatIsoMonth,
  Paginated,
} from '../common';
import type {
  MentorCourseDto,
  MentorCourseQueryDto,
  MentorGroupDto,
  MentorGroupQueryDto,
  MentorMaterialDto,
  MentorMaterialQueryDto,
  MentorProfileDto,
  MentorTimetableQueryDto,
  MentorTimetableSlotDto,
} from './dto';
import type {
  MentorCourseRow,
  MentorGroupRef,
  MentorGroupRow,
  MentorLessonRow,
  MentorLevelOfMonthRow,
  MentorProfileRow,
  MentorSlotRow,
} from './mentor-cabinet.repository';
import { MentorCabinetRepository } from './mentor-cabinet.repository';

/**
 * Кабинет ментора (ТЗ 5.4: «Профиль ментора … Меню: Profile, Groups, Material,
 * Timetable, Courses, SMS mailings»).
 *
 * Второй в проекте контур «своё» — после кабинета студента (сессия 0017),
 * и устроен он по тем же правилам:
 *   - **всё адресуется от токена, а не от пути.** Идентификатор сотрудника
 *     в запросах не участвует: он выводится из аккаунта вызывающего, поэтому
 *     «посмотреть чужое» здесь нечем даже при ошибке в коде;
 *   - **каждая выборка сужена менторством** (`mentors: { some: { employeeId } }`),
 *     а не проверкой после выборки: чужие группы, курсы и материалы не попадают
 *     сюда по построению;
 *   - **выведенному из штата кабинет закрыт (403).** `INACTIVE` по решению
 *     сессии 0020 означает и закрытый вход; профиль здесь читается на каждый
 *     запрос, поэтому запрет обходится бесплатно и действует сразу, не дожидаясь,
 *     пока истечёт уже выданный access-токен;
 *   - **прав каталога нет.** Кабинет отдаёт только то, что и так принадлежит
 *     вызывающему, — требовать за это право значило бы завести право «видеть
 *     себя», которое пришлось бы выдавать каждому сотруднику поимённо. Обратная
 *     сторона правила: то, на что права нужны (состав групп, стоимость курса,
 *     чужие заявки), кабинет и не показывает.
 *
 * Позиция «Mentor» не спрашивается — четвёртый раз то же решение, что в сессиях
 * 0010, 0020 и 0021: правило держалось бы на названии позиции, которое
 * редактируется через `/positions`. Сотрудник без единой группы просто видит
 * пустые разделы, а не отказ.
 *
 * Раздела «SMS mailings» из меню ТЗ 5.4 здесь нет: рассылки — Фаза 11, и раньше
 * неё маршрут отдавал бы пустоту, ничего не обещая (правило сессий 0017–0018
 * о параметрах и разделах, которые есть и молча ничего не делают).
 */
@Injectable()
export class MentorCabinetService {
  constructor(
    private readonly repository: MentorCabinetRepository,
    private readonly avans: AvansService,
  ) {}

  /**
   * Свой профиль вместе с уровнем и ставкой **текущего** месяца (ТЗ 5.4:
   * «уровень + часовая ставка»).
   *
   * Месяц уходит в ответ явным полем: значение зависит от того, когда задан
   * вопрос, и без месяца профиль отвечал бы по-разному первого и тридцать
   * первого числа без единого изменения данных. Ровно поэтому сессия 0021
   * и не стала класть уровень в `EmployeeDto`, оставив его профилю ментора.
   */
  async profile(accountId: string): Promise<MentorProfileDto> {
    const employee = await this.requireEmployee(accountId);
    const level = await this.repository.findLevelOfMonth(employee.id, startOfCurrentMonth());

    return toProfileDto(employee, level);
  }

  async groups(accountId: string, query: MentorGroupQueryDto): Promise<Paginated<MentorGroupDto>> {
    const employee = await this.requireEmployee(accountId);

    const { rows, total } = await this.repository.findGroups({
      employeeId: employee.id,
      search: query.search,
      role: query.role,
      status: query.status,
      sort: query.sort,
      order: query.order,
      skip: query.skip,
      take: query.take,
    });

    return Paginated.from(rows.map(toGroupDto), total, query);
  }

  async timetable(
    accountId: string,
    query: MentorTimetableQueryDto,
  ): Promise<Paginated<MentorTimetableSlotDto>> {
    const employee = await this.requireEmployee(accountId);

    if (query.groupId !== undefined) {
      await this.assertMyGroup(employee.id, query.groupId);
    }

    const { rows, total } = await this.repository.findTimetable({
      employeeId: employee.id,
      search: query.search,
      groupId: query.groupId,
      dayOfWeek: query.dayOfWeek,
      onlyMine: query.onlyMine,
      sort: query.sort,
      order: query.order,
      skip: query.skip,
      take: query.take,
    });

    return Paginated.from(
      rows.map((row) => toSlotDto(row, employee.id)),
      total,
      query,
    );
  }

  /**
   * Курсы, по которым сотрудник ведёт хотя бы одну группу (ТЗ 5.4, «Courses»).
   *
   * Свои группы подставляются **одним запросом на страницу**, а не вложенной
   * выборкой: фильтр в ней зависел бы от вызывающего, и статический `select`
   * перестал бы быть статическим. Тот же приём, что с агрегатами баллов
   * в списке студентов (сессия 0019).
   */
  async courses(
    accountId: string,
    query: MentorCourseQueryDto,
  ): Promise<Paginated<MentorCourseDto>> {
    const employee = await this.requireEmployee(accountId);

    const { rows, total } = await this.repository.findCourses({
      employeeId: employee.id,
      search: query.search,
      sort: query.sort,
      order: query.order,
      skip: query.skip,
      take: query.take,
    });

    const groups = await this.repository.findGroupsOfCourses(
      employee.id,
      rows.map((row) => row.id),
    );

    return Paginated.from(
      rows.map((row) => toCourseDto(row, groupsBy(groups, 'courseId', row.id))),
      total,
      query,
    );
  }

  /**
   * Материалы своих групп (ТЗ 5.4, «Material»).
   *
   * Источник раздела — «Show to group» силлабуса (ТЗ 5.6, сессия 0009): ментор
   * видит не всю программу курса, а то, что методист открыл его группам. Вся
   * программа читается своим маршрутом (`GET /courses/{id}/lessons`) и требует
   * права `Permission.Syllabus.Views`.
   */
  async materials(
    accountId: string,
    query: MentorMaterialQueryDto,
  ): Promise<Paginated<MentorMaterialDto>> {
    const employee = await this.requireEmployee(accountId);

    if (query.groupId !== undefined) {
      await this.assertMyGroup(employee.id, query.groupId);
    }

    const { rows, total } = await this.repository.findMaterials({
      employeeId: employee.id,
      search: query.search,
      groupId: query.groupId,
      courseId: query.courseId,
      type: query.type,
      sort: query.sort,
      order: query.order,
      skip: query.skip,
      take: query.take,
    });

    const groups = await this.repository.findGroupsOfLessons(
      employee.id,
      rows.map((row) => row.id),
    );

    return Paginated.from(
      rows.map((row) => toMaterialDto(row, groupsBy(groups, 'lessonId', row.id))),
      total,
      query,
    );
  }

  // ──────────────────────── Аванс о себе (ТЗ 5.4, 5.14) ──────────────────────

  /**
   * Свои заявки на аванс — три маршрута кабинета переиспользуют `AvansService`,
   * а не повторяют его правила.
   *
   * Так же поступил кабинет студента с расчётом успеваемости (сессия 0020):
   * через границу модуля переходит **сервис**, а не чистая функция, потому что
   * вопрос тот же самый. Правила «одна нерассмотренная заявка», «месяц зарплаты
   * обязателен» и «рассмотренная не отзывается» (сессия 0022) — деньги, и второй
   * их экземпляр разошёлся бы с первым молча.
   *
   * Права `Permission.Avans.Create` здесь нет намеренно: оно означает «завести
   * заявку **любому** сотруднику», и выдав его каждому ментору ради подачи
   * о себе, мы открыли бы подачу за коллег. Заявка о себе адресуется токеном —
   * как и всё остальное в кабинете.
   */
  async avansRequests(
    accountId: string,
    query: AvansQueryDto,
  ): Promise<Paginated<AvansRequestDto>> {
    const employee = await this.requireEmployee(accountId);

    return this.avans.findAll(employee.id, query);
  }

  async createAvansRequest(
    accountId: string,
    dto: CreateAvansRequestDto,
  ): Promise<AvansRequestDto> {
    const employee = await this.requireEmployee(accountId);

    // Автор — тот же аккаунт: заявка о себе подписана собой, и это видно
    // бухгалтерии Фазы 9 по `createdBy`, совпадающему с `employeeId`.
    return this.avans.create(employee.id, dto, accountId);
  }

  async cancelAvansRequest(accountId: string, avansId: string): Promise<AvansRequestCancelledDto> {
    const employee = await this.requireEmployee(accountId);

    return this.avans.remove(employee.id, avansId);
  }

  /**
   * Профиль вызывающего. Читается на каждый запрос кабинета — тип аккаунта
   * в токене говорит лишь «это сотрудник», а какой именно, знает только БД
   * (стратегия намеренно в неё не ходит, решение сессии 0002).
   *
   * 404 здесь означает аккаунт типа `EMPLOYEE` без профиля. По ТЗ 3.1 такого
   * состояния быть не должно (удаление профиля уносит аккаунт, сессия 0020),
   * но выдумывать пустой кабинет вместо честного отказа не станем.
   */
  private async requireEmployee(accountId: string): Promise<MentorProfileRow> {
    const employee = await this.repository.findByAccountId(accountId);
    if (!employee) {
      throw new NotFoundException('Профиль сотрудника не найден');
    }

    if (employee.status === EmployeeStatus.INACTIVE) {
      throw new ForbiddenException('Сотрудник выведен из штата — обратитесь в учебный центр');
    }

    return employee;
  }

  /**
   * Фильтр по группе действует только в пределах своих групп.
   *
   * 422, а не 404: адрес найден, не найдено то, что пришло в запросе (то же
   * правило, что для ссылок в теле — сессии 0006–0009). Чужая и несуществующая
   * группа отвечают одинаково: иначе кабинет работал бы способом перебрать,
   * какие группы вообще есть в центре (решение сессии 0017).
   */
  private async assertMyGroup(employeeId: string, groupId: string): Promise<void> {
    const assignment = await this.repository.findAssignment(employeeId, groupId);
    if (!assignment) {
      throw new BusinessRuleException('Вы не ведёте эту группу', { groupId });
    }
  }
}

/** Первое число текущего месяца — тот же вид, в каком месяц лежит в БД (0021). */
const startOfCurrentMonth = (): Date => {
  const now = new Date();

  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
};

/** Строки «моя группа» страницы, относящиеся к одной записи списка. */
const groupsBy = <K extends 'courseId' | 'lessonId'>(
  rows: readonly (MentorGroupRef & Record<K, string>)[],
  key: K,
  value: string,
): MentorGroupRef[] =>
  rows.filter((row) => row[key] === value).map(({ id, name }) => ({ id, name }));

const toProfileDto = (
  row: MentorProfileRow,
  level: MentorLevelOfMonthRow | null,
): MentorProfileDto => ({
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
  positions: row.positions.map(({ position }) => position),
  level:
    level === null
      ? null
      : {
          month: formatIsoMonth(level.month),
          id: level.level.id,
          name: level.level.name,
          // `Prisma.Decimal` → число через `Number()`, а не `toNumber()`: так же
          // корректно, но не падает, если в слое данных лежит обычное число (0007).
          hourlyRate: Number(level.level.hourlyRate),
          status: level.level.status,
        },
  createdAt: row.createdAt.toISOString(),
});

const toGroupDto = (row: MentorGroupRow): MentorGroupDto => ({
  id: row.group.id,
  name: row.group.name,
  description: row.group.description,
  course: row.group.course,
  branch: row.group.branch,
  format: row.group.format,
  status: row.group.status,
  startDate: row.group.startDate === null ? null : formatIsoDate(row.group.startDate),
  endDate: row.group.endDate === null ? null : formatIsoDate(row.group.endDate),
  capacity: row.group.capacity,
  enrolledCount: row.group._count.students,
  telegramUrl: row.group.telegramUrl,
  role: row.role,
  assignedAt: row.assignedAt.toISOString(),
});

const toSlotDto = (row: MentorSlotRow, employeeId: string): MentorTimetableSlotDto => ({
  id: row.id,
  group: {
    id: row.group.id,
    name: row.group.name,
    courseId: row.group.course.id,
    courseTitle: row.group.course.title,
  },
  dayOfWeek: row.dayOfWeek,
  startTime: formatDayTime(row.startMinute),
  endTime: formatDayTime(row.endMinute),
  room: row.room,
  mentor: row.mentor,
  mine: row.mentorId === employeeId,
});

const toCourseDto = (row: MentorCourseRow, groups: MentorGroupRef[]): MentorCourseDto => ({
  id: row.id,
  title: row.title,
  subtitle: row.subtitle,
  description: row.description,
  colorPrimary: row.colorPrimary,
  colorSecondary: row.colorSecondary,
  logoUrl: row.logoUrl,
  durationValue: row.durationValue,
  durationUnit: row.durationUnit,
  isLastCourse: row.isLastCourse,
  status: row.status,
  groups,
});

const toMaterialDto = (row: MentorLessonRow, groups: MentorGroupRef[]): MentorMaterialDto => ({
  id: row.id,
  course: row.course,
  dayNumber: row.dayNumber,
  title: row.title,
  description: row.description,
  type: row.type,
  status: row.status,
  groups,
  files: row.files,
});
