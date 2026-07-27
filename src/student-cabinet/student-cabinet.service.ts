import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { StudentStatus } from '@prisma/client';

import { BusinessRuleException, formatDayTime, formatIsoDate, Paginated } from '../common';
import type {
  MeGroupDto,
  MeGroupQueryDto,
  MeProfileDto,
  MeScheduleQueryDto,
  MeScheduleSlotDto,
} from './dto';
import type { MeMembershipRow, MeProfileRow, MeSlotRow } from './student-cabinet.repository';
import { StudentCabinetRepository } from './student-cabinet.repository';

/**
 * Кабинет студента (ТЗ 5.3: «только просмотр — свои баллы, свои группы, свой
 * профиль, рейтинг, расписание»; ТЗ 3.2: полномочия студента — просмотр).
 *
 * Правила модуля:
 *   - **всё адресуется от токена, а не от пути.** Идентификатор студента
 *     в запросе не участвует вообще: он выводится из аккаунта вызывающего,
 *     поэтому «посмотреть чужое» здесь нечем даже при ошибке в коде;
 *   - **расписание — только действующих членств.** Покинутая группа остаётся
 *     в «моих группах» историей, но её занятия к расписанию человека больше
 *     не относятся;
 *   - **заблокированному кабинет закрыт (403).** Блокировка по ТЗ 5.3 — это
 *     закрытие входа; профиль здесь и так читается на каждый запрос, поэтому
 *     запрет обходится бесплатно и действует сразу, не дожидаясь, пока истечёт
 *     уже выданный access-токен.
 *
 * Баллов и рейтинга здесь нет: они считаются по журналу (ТЗ 5.8), которого
 * не существует до Фазы 5. Пустой раздел был бы враньём, а не заготовкой.
 */
@Injectable()
export class StudentCabinetService {
  constructor(private readonly repository: StudentCabinetRepository) {}

  async profile(accountId: string): Promise<MeProfileDto> {
    return toProfileDto(await this.requireStudent(accountId));
  }

  async groups(accountId: string, query: MeGroupQueryDto): Promise<Paginated<MeGroupDto>> {
    const student = await this.requireStudent(accountId);

    const { rows, total } = await this.repository.findMemberships({
      studentId: student.id,
      search: query.search,
      status: query.status,
      sort: query.sort,
      order: query.order,
      skip: query.skip,
      take: query.take,
    });

    return Paginated.from(rows.map(toGroupDto), total, query);
  }

  async schedule(
    accountId: string,
    query: MeScheduleQueryDto,
  ): Promise<Paginated<MeScheduleSlotDto>> {
    const student = await this.requireStudent(accountId);

    if (query.groupId !== undefined) {
      await this.assertMyGroup(student.id, query.groupId);
    }

    const { rows, total } = await this.repository.findSchedule({
      studentId: student.id,
      search: query.search,
      groupId: query.groupId,
      dayOfWeek: query.dayOfWeek,
      sort: query.sort,
      order: query.order,
      skip: query.skip,
      take: query.take,
    });

    return Paginated.from(rows.map(toSlotDto), total, query);
  }

  /**
   * Профиль вызывающего. Читается на каждый запрос кабинета — тип аккаунта
   * в токене говорит лишь «это студент», а какой именно, знает только БД
   * (стратегия намеренно в неё не ходит, решение сессии 0002).
   *
   * 404 здесь означает аккаунт типа `STUDENT` без профиля. По ТЗ 3.1 такого
   * состояния быть не должно (удаление профиля уносит аккаунт), но выдумывать
   * пустой кабинет вместо честного отказа кабинет не станет.
   */
  private async requireStudent(accountId: string): Promise<MeProfileRow> {
    const student = await this.repository.findByAccountId(accountId);
    if (!student) {
      throw new NotFoundException('Профиль студента не найден');
    }

    if (student.status === StudentStatus.BLOCK) {
      throw new ForbiddenException('Профиль заблокирован — обратитесь в учебный центр');
    }

    return student;
  }

  /**
   * Фильтр по группе действует только в пределах своих действующих групп.
   *
   * 422, а не 404: адрес `/me/schedule` найден, не найдено то, что пришло
   * в запросе (то же правило, что для ссылок в теле — сессии 0006–0009).
   * Чужая и несуществующая группа отвечают одинаково: иначе кабинет работал бы
   * способом перебрать, какие группы есть в центре.
   */
  private async assertMyGroup(studentId: string, groupId: string): Promise<void> {
    const membership = await this.repository.findActiveMembership(studentId, groupId);
    if (!membership) {
      throw new BusinessRuleException('Вы не учитесь в этой группе', { groupId });
    }
  }
}

const toProfileDto = (row: MeProfileRow): MeProfileDto => ({
  id: row.id,
  firstName: row.firstName,
  lastName: row.lastName,
  phone: row.phone,
  birthDate: row.birthDate === null ? null : formatIsoDate(row.birthDate),
  gender: row.gender,
  address: row.address,
  email: row.email,
  extraPhones: row.extraPhones,
  telegram: row.telegram,
  photoUrl: row.photoUrl,
  branch: row.branch,
  status: row.status,
  parents: row.parents.map(({ parent, relation }) => ({
    id: parent.id,
    firstName: parent.firstName,
    lastName: parent.lastName,
    phone: parent.phone,
    relation,
  })),
  createdAt: row.createdAt.toISOString(),
});

const toGroupDto = (row: MeMembershipRow): MeGroupDto => ({
  id: row.group.id,
  name: row.group.name,
  course: row.group.course,
  branch: row.group.branch,
  format: row.group.format,
  groupStatus: row.group.status,
  startDate: row.group.startDate === null ? null : formatIsoDate(row.group.startDate),
  endDate: row.group.endDate === null ? null : formatIsoDate(row.group.endDate),
  telegramUrl: row.group.telegramUrl,
  mentors: row.group.mentors.map(({ employee, role }) => ({
    id: employee.id,
    firstName: employee.firstName,
    lastName: employee.lastName,
    middleName: employee.middleName,
    role,
  })),
  status: row.status,
  statusReason: row.statusReason,
  statusChangedAt: row.statusChangedAt === null ? null : row.statusChangedAt.toISOString(),
  enrolledAt: row.enrolledAt.toISOString(),
});

const toSlotDto = (row: MeSlotRow): MeScheduleSlotDto => ({
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
});
