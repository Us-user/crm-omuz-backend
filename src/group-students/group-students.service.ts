import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { GroupStudentStatus } from '@prisma/client';

import { BusinessRuleException, Paginated } from '../common';
import type {
  AddGroupStudentsDto,
  ChangeGroupStudentsStatusDto,
  GroupStudentDto,
  GroupStudentQueryDto,
  GroupStudentRemovedDto,
  GroupStudentsAddedDto,
  GroupStudentsStatusChangedDto,
  GroupStudentsTransferredDto,
  TransferGroupStudentsDto,
} from './dto';
import type {
  CompetingMembership,
  GroupStudentRow,
  StudentGroup,
} from './group-students.repository';
import { GroupStudentsRepository } from './group-students.repository';

/**
 * Состав группы (ТЗ 5.5: «состав студентов», массовые «Change status» и «Transfer»).
 *
 * Правила модуля:
 *   - группа из пути должна существовать (404) — она часть адреса, а не тела;
 *   - студенты из тела должны существовать (422 с перечислением недостающих:
 *     ресурс из пути найден, не найдено то, что пришло в теле);
 *   - у студента одно действующее членство на курс (409): учиться на Frontend
 *     и English параллельно можно, в двух группах одного курса — нет
 *     (решение сессии 0012);
 *   - смена статуса и перевод требуют причины (ТЗ 5.5) и не удаляют членство:
 *     закрытая строка и есть учебная история студента.
 *
 * Статус членства не трогает `Student.status` (ТЗ 5.3): им управляет карточка
 * студента, а уход из одной группы не означает ухода из центра.
 */
@Injectable()
export class GroupStudentsService {
  private readonly logger = new Logger(GroupStudentsService.name);

  constructor(private readonly repository: GroupStudentsRepository) {}

  async findAll(groupId: string, query: GroupStudentQueryDto): Promise<Paginated<GroupStudentDto>> {
    await this.requireGroup(groupId);

    const { rows, total } = await this.repository.findMany({
      groupId,
      search: query.search,
      status: query.status,
      sort: query.sort,
      order: query.order,
      skip: query.skip,
      take: query.take,
    });

    return Paginated.from(rows.map(toDto), total, query);
  }

  /**
   * Зачисление пачкой. Вместимость (`capacity`) при этом не ограничивает набор:
   * «Required students» из ТЗ 5.5 — это плановая цифра для показа «набрано/
   * вместимость», а не запрет. Отказ на 17-м студенте в группе на 16 мест
   * заставлял бы править план ради того, что и так происходит.
   */
  async add(groupId: string, dto: AddGroupStudentsDto): Promise<GroupStudentsAddedDto> {
    const group = await this.requireGroup(groupId);

    await this.assertStudentsExist(dto.studentIds);
    await this.assertNotAlreadyEnrolled(groupId, dto.studentIds);
    await this.assertFreeOfCourse(group, dto.studentIds, [groupId]);

    const students = await this.repository.enroll(groupId, dto.studentIds, new Date());
    const enrolledCount = await this.repository.countActive(groupId);

    this.logger.log(
      `В группу ${group.name} зачислено студентов: ${String(students.length)} (в составе ${String(enrolledCount)})`,
    );

    return { groupId, students: students.map(toDto), enrolledCount };
  }

  /**
   * Массовая смена статуса участия с обязательной причиной (ТЗ 5.5).
   *
   * `TRANSFERRED` здесь недоступен: перевод — это две записи (закрыть здесь,
   * завести там), и поставить статус в обход `/transfer` значило бы получить
   * студента, который «переведён» в никуда.
   */
  async changeStatus(
    groupId: string,
    dto: ChangeGroupStudentsStatusDto,
  ): Promise<GroupStudentsStatusChangedDto> {
    const group = await this.requireGroup(groupId);

    if (dto.status === GroupStudentStatus.TRANSFERRED) {
      throw new BusinessRuleException(
        'Статус TRANSFERRED ставится переводом в другую группу, а не сменой статуса',
        { status: dto.status },
      );
    }

    await this.assertEnrolled(groupId, dto.studentIds);

    // Возврат в обучение — то же зачисление по существу, поэтому и правило
    // «одно действующее членство на курс» проверяется так же.
    if (dto.status === GroupStudentStatus.ACTIVE) {
      await this.assertFreeOfCourse(group, dto.studentIds, [groupId]);
    }

    const students = await this.repository.changeStatus(
      groupId,
      dto.studentIds,
      dto.status,
      dto.reason,
      new Date(),
    );
    const enrolledCount = await this.repository.countActive(groupId);

    this.logger.log(
      `В группе ${group.name} статус ${dto.status} у студентов: ${String(students.length)} ` +
        `(причина: ${dto.reason})`,
    );

    return { groupId, status: dto.status, students: students.map(toDto), enrolledCount };
  }

  /** Массовый перевод в другую группу (ТЗ 5.5: «Transfer в другую группу»). */
  async transfer(
    groupId: string,
    dto: TransferGroupStudentsDto,
  ): Promise<GroupStudentsTransferredDto> {
    const group = await this.requireGroup(groupId);

    if (dto.targetGroupId === groupId) {
      throw new BusinessRuleException('Группа назначения совпадает с исходной', {
        targetGroupId: dto.targetGroupId,
      });
    }

    const target = await this.repository.findGroup(dto.targetGroupId);
    if (!target) {
      throw new BusinessRuleException('Группа назначения не найдена', {
        targetGroupId: dto.targetGroupId,
      });
    }

    await this.assertEnrolled(groupId, dto.studentIds);
    // Курс проверяется у группы **назначения**: перевод на соседний курс —
    // законное действие, а вот два действующих членства на нём — нет.
    await this.assertFreeOfCourse(target, dto.studentIds, [groupId, target.id]);

    const students = await this.repository.transfer({
      fromGroupId: groupId,
      toGroupId: target.id,
      studentIds: dto.studentIds,
      reason: dto.reason,
      changedAt: new Date(),
    });
    const enrolledCount = await this.repository.countActive(groupId);

    this.logger.log(
      `Из группы ${group.name} в группу ${target.name} переведено студентов: ` +
        `${String(students.length)} (причина: ${dto.reason})`,
    );

    return {
      fromGroupId: groupId,
      toGroupId: target.id,
      students: students.map(toDto),
      enrolledCount,
    };
  }

  /**
   * Исключение из состава — строка удаляется целиком, вместе с историей.
   * Маршрута нет в перечне ТЗ 5.5, но без него зачисленного по ошибке студента
   * пришлось бы «увольнять» причиной ухода, и он навсегда остался бы в отчёте
   * по покинувшим курс (ТЗ 5.12). Настоящий уход оформляется сменой статуса.
   */
  async remove(groupId: string, studentId: string): Promise<GroupStudentRemovedDto> {
    const membership = await this.requireMembership(groupId, studentId);

    await this.repository.delete(groupId, studentId);
    const enrolledCount = await this.repository.countActive(groupId);

    this.logger.log(`Студент ${fullName(membership.student)} убран из состава группы ${groupId}`);

    return { groupId, studentId, fullName: fullName(membership.student), enrolledCount };
  }

  // ──────────────────────────────── Правила ─────────────────────────────────

  private async requireGroup(groupId: string): Promise<StudentGroup> {
    const group = await this.repository.findGroup(groupId);
    if (!group) {
      throw new NotFoundException('Группа не найдена');
    }

    return group;
  }

  /**
   * Членство вместе с группой из пути. Группа проверяется отдельным запросом,
   * чтобы отличить «нет такой группы» от «у группы нет такого студента»: без
   * этого опечатка в идентификаторе группы выглядела бы как пропавший студент.
   */
  private async requireMembership(groupId: string, studentId: string): Promise<GroupStudentRow> {
    await this.requireGroup(groupId);

    const membership = await this.repository.findOne(groupId, studentId);
    if (!membership) {
      throw new NotFoundException('Студент не состоит в этой группе');
    }

    return membership;
  }

  /** 422 с перечислением **только** недостающих — не всего присланного списка. */
  private async assertStudentsExist(studentIds: string[]): Promise<void> {
    const found = await this.repository.findStudents(studentIds);
    const known = new Set(found.map((student) => student.id));
    const missing = studentIds.filter((id) => !known.has(id));

    if (missing.length > 0) {
      throw new BusinessRuleException('Студенты не найдены', { studentIds: missing });
    }
  }

  /**
   * Повторное зачисление действующего студента — 409, а не «тихий апсерт»:
   * иначе повтор запроса молча сбрасывал бы дату зачисления. Закрытое членство
   * (ушёл, завершил, переведён) зачислению не мешает — это и есть возвращение
   * в группу.
   */
  private async assertNotAlreadyEnrolled(groupId: string, studentIds: string[]): Promise<void> {
    const memberships = await this.repository.findMemberships(groupId, studentIds);
    const active = memberships.filter(
      (membership) => membership.status === GroupStudentStatus.ACTIVE,
    );

    if (active.length > 0) {
      throw new ConflictException(
        `Уже в составе группы: ${active.map((membership) => fullName(membership.student)).join(', ')}`,
      );
    }
  }

  /** Все перечисленные студенты должны состоять в группе — иначе 422 с недостающими. */
  private async assertEnrolled(groupId: string, studentIds: string[]): Promise<void> {
    const memberships = await this.repository.findMemberships(groupId, studentIds);
    const known = new Set(memberships.map((membership) => membership.studentId));
    const missing = studentIds.filter((id) => !known.has(id));

    if (missing.length > 0) {
      throw new BusinessRuleException('Студенты не состоят в этой группе', {
        studentIds: missing,
      });
    }
  }

  /**
   * Одно действующее членство на курс (решение сессии 0012). Две группы одного
   * курса означали бы два журнала и два начисления по одной и той же программе
   * (ТЗ 5.8), а почти всегда это просто опечатка в выборе группы.
   */
  private async assertFreeOfCourse(
    group: StudentGroup,
    studentIds: string[],
    exceptGroupIds: string[],
  ): Promise<void> {
    const competing = await this.repository.findCompetingMemberships(
      group.courseId,
      studentIds,
      exceptGroupIds,
    );

    if (competing.length > 0) {
      throw new ConflictException(
        `Уже учатся в другой группе этого курса: ${competing.map(describeCompeting).join(', ')}`,
      );
    }
  }
}

/** «Фамилия Имя» — тот же порядок, что в списках сотрудников и студентов. */
const fullName = (person: { firstName: string; lastName: string }): string =>
  `${person.lastName} ${person.firstName}`;

const describeCompeting = (membership: CompetingMembership): string =>
  `${fullName(membership.student)} (${membership.group.name})`;

const toDto = (row: GroupStudentRow): GroupStudentDto => ({
  groupId: row.groupId,
  student: {
    id: row.student.id,
    firstName: row.student.firstName,
    lastName: row.student.lastName,
    phone: row.student.phone,
    photoUrl: row.student.photoUrl,
    status: row.student.status,
  },
  status: row.status,
  statusReason: row.statusReason,
  statusChangedAt: row.statusChangedAt === null ? null : row.statusChangedAt.toISOString(),
  transferredFrom: row.transferredFromGroup,
  enrolledAt: row.enrolledAt.toISOString(),
});
