import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { GroupStudentStatus } from '@prisma/client';

import { BusinessRuleException, formatCsv, formatIsoDate, Paginated, parseCsv } from '../common';
import { PhoneService } from '../phone/phone.service';
import { deriveStudentStatus } from '../students/student-status';
import type {
  AddGroupStudentsDto,
  ChangeGroupStudentsStatusDto,
  ExportGroupStudentsQueryDto,
  GroupStudentDto,
  GroupStudentQueryDto,
  GroupStudentRemovedDto,
  GroupStudentsAddedDto,
  GroupStudentsImportedDto,
  GroupStudentsStatusChangedDto,
  GroupStudentsTransferredDto,
  ImportGroupStudentsDto,
  TransferGroupStudentsDto,
} from './dto';
import { MAX_IMPORT_ROWS } from './dto';
import {
  findPhoneColumn,
  GROUP_STUDENTS_CSV_HEADER,
  PHONE_COLUMN_ALIASES,
  readPhoneCell,
  toCsvRow,
} from './group-students.csv';
import type {
  CompetingMembership,
  GroupStudentRow,
  StudentGroup,
  StudentStatusUpdate,
} from './group-students.repository';
import { GroupStudentsRepository } from './group-students.repository';

/** Готовый файл выгрузки: контроллеру остаётся проставить заголовки. */
export interface GroupStudentsCsvFile {
  content: string;
  fileName: string;
  /** Имя без кириллицы — для заголовка `Content-Disposition` старых клиентов. */
  asciiFileName: string;
  rows: number;
}

/** Строка файла, отвергнутая импортом (ТЗ 5.5: отчёт по строкам). */
interface ImportRowError {
  line: number;
  phone: string;
  reason: string;
}

/** Сколько отвергнутых строк перечисляется в ответе. */
const MAX_REPORTED_ERRORS = 50;

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
 * Статус членства и статус профиля (`Student.status`, ТЗ 5.3) — разные вещи,
 * но не независимые: после каждого изменения состава профиль пересчитывается
 * из **всех** членств студента (`syncProfileStatuses`). Уход из одной группы
 * не означает ухода из центра, пока человек учится в другой.
 */
@Injectable()
export class GroupStudentsService {
  private readonly logger = new Logger(GroupStudentsService.name);

  constructor(
    private readonly repository: GroupStudentsRepository,
    private readonly phones: PhoneService,
  ) {}

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
    await this.syncProfileStatuses(dto.studentIds);
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

    // «Ментор на момент ухода» (ТЗ 5.12) фиксируется снимком именно здесь:
    // это единственный момент, когда состав менторов группы ещё описывает
    // то, из-под кого студент ушёл. Один запрос на всю пачку — статус
    // и группа у неё общие.
    const mentorAtLeaveId =
      dto.status === GroupStudentStatus.LEFT
        ? await this.repository.findLeaveMentor(groupId)
        : null;

    const students = await this.repository.changeStatus(
      groupId,
      dto.studentIds,
      dto.status,
      dto.reason,
      new Date(),
      mentorAtLeaveId,
    );
    await this.syncProfileStatuses(dto.studentIds);
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
    await this.syncProfileStatuses(dto.studentIds);
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
   * Выгрузка состава в CSV (ТЗ 5.5: «Import/Export»).
   *
   * Выгружается **весь** отобранный состав, а не страница: файл из двадцати
   * строк не является выгрузкой группы. Закрытые членства из файла не пропадают
   * по той же причине, что и из списка, — состав группы это её история;
   * фильтр `status=LEFT` даёт секцию «Left course» из ТЗ 5.5 отдельным файлом.
   */
  async exportCsv(
    groupId: string,
    query: ExportGroupStudentsQueryDto,
  ): Promise<GroupStudentsCsvFile> {
    const group = await this.requireGroup(groupId);

    const rows = await this.repository.findAllForExport({
      groupId,
      status: query.status,
      search: query.search,
    });

    const content = formatCsv([GROUP_STUDENTS_CSV_HEADER, ...rows.map(toCsvRow)], { bom: true });
    const date = formatIsoDate(new Date());

    this.logger.log(`Выгружен состав группы ${group.name}: строк ${String(rows.length)}`);

    return {
      content,
      fileName: `Состав группы ${group.name} ${date}.csv`,
      asciiFileName: `group-students-${date}.csv`,
      rows: rows.length,
    };
  }

  /**
   * Импорт состава из CSV (ТЗ 5.5).
   *
   * Файл только **зачисляет уже заведённых** студентов: связь ищется
   * по телефону (`Student.phone` уникален). Создавать профили импорт
   * не умеет — это карточка студента из Фазы 4 со своей валидацией всех
   * полей формы (ТЗ 5.3), и делать её боком, через CSV, значило бы завести
   * второй, менее строгий способ заводить людей.
   *
   * Проверяется весь файл целиком, и при первой же ошибочной строке
   * не применяется ничего (решение сессии 0013): импорт из десяти строк,
   * применившийся на семь, оставляет оператора с вопросом, какие семь, —
   * а поправить и повторить файл он может только целиком.
   */
  async importCsv(groupId: string, dto: ImportGroupStudentsDto): Promise<GroupStudentsImportedDto> {
    const group = await this.requireGroup(groupId);

    const studentIds = await this.readImportFile(group, dto.csv);

    const students = await this.repository.enroll(groupId, studentIds, new Date());
    await this.syncProfileStatuses(studentIds);
    const enrolledCount = await this.repository.countActive(groupId);

    this.logger.log(
      `Импорт в группу ${group.name}: зачислено ${String(students.length)} ` +
        `(в составе ${String(enrolledCount)})`,
    );

    return { groupId, imported: students.length, students: students.map(toDto), enrolledCount };
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
    await this.syncProfileStatuses([studentId]);
    const enrolledCount = await this.repository.countActive(groupId);

    this.logger.log(`Студент ${fullName(membership.student)} убран из состава группы ${groupId}`);

    return { groupId, studentId, fullName: fullName(membership.student), enrolledCount };
  }

  /**
   * Пересчитывает статусы профилей затронутых студентов (ТЗ 5.3) — правило
   * `deriveStudentStatus` из модуля студентов. Связь между статусом членства
   * и статусом профиля решена в сессии 0014; сессия 0012 оставила её открытой,
   * потому что до карточки студента опереть правило было не на что.
   *
   * Пересчёт идёт **после** транзакции состава, а не внутри неё. Так он
   * проверяем по всей цепочке (сервис → репозиторий) и не заставляет слой
   * данных знать правило. Цена честная: сбой между двумя шагами оставит
   * профиль с прежним статусом при верных членствах. Это восстановимо —
   * вывод идемпотентен, и следующая же операция над составом его исправит, —
   * а обратный порядок ошибки (верный статус при неверных членствах)
   * был бы порчей самих данных.
   */
  private async syncProfileStatuses(studentIds: string[]): Promise<void> {
    const students = await this.repository.findStudentsWithMemberships(studentIds);

    const updates = students.reduce<StudentStatusUpdate[]>((acc, student) => {
      const status = deriveStudentStatus(student.status, student.groups);
      if (status !== null) acc.push({ studentId: student.id, status });

      return acc;
    }, []);

    if (updates.length === 0) return;

    await this.repository.setStudentStatuses(updates);
    this.logger.log(
      `Пересчитан статус профиля у студентов: ${updates
        .map(({ studentId, status }) => `${studentId} → ${status}`)
        .join(', ')}`,
    );
  }

  // ──────────────────────────────── Импорт ──────────────────────────────────

  /**
   * Разбирает файл и превращает его в список профилей для зачисления.
   *
   * Ошибки не прерывают разбор, а копятся: оператор должен увидеть **все**
   * плохие строки за один заход, иначе исправление файла превращается
   * в перебор — поправил четвёртую строку, узнал про девятую.
   */
  private async readImportFile(group: StudentGroup, csv: string): Promise<string[]> {
    const records = parseCsv(csv);
    const header = records[0];

    if (header === undefined) {
      throw new BadRequestException({
        message: 'Файл пуст',
        details: { csv: 'Ожидается строка заголовка и хотя бы одна строка с телефоном' },
      });
    }

    const phoneColumn = findPhoneColumn(header.values);
    if (phoneColumn === -1) {
      throw new BadRequestException({
        message: 'В заголовке файла не найдена колонка с телефоном',
        details: {
          expected: [...PHONE_COLUMN_ALIASES],
          received: header.values,
        },
      });
    }

    const dataRows = records.slice(1);
    if (dataRows.length === 0) {
      throw new BadRequestException({
        message: 'Файл не содержит ни одной строки с данными',
        details: { csv: 'После заголовка ожидается хотя бы один телефон' },
      });
    }
    if (dataRows.length > MAX_IMPORT_ROWS) {
      throw new BadRequestException({
        message: `Слишком много строк: максимум ${String(MAX_IMPORT_ROWS)}`,
        details: { rows: dataRows.length },
      });
    }

    const errors: ImportRowError[] = [];
    /** Телефон → строка файла, в которой он встретился впервые. */
    const seen = new Map<string, number>();
    const candidates: { line: number; phone: string }[] = [];

    for (const record of dataRows) {
      const raw = readPhoneCell(record.values[phoneColumn]);

      if (raw === '') {
        errors.push({ line: record.line, phone: '', reason: 'Телефон не указан' });
        continue;
      }

      let phone: string;
      try {
        phone = this.phones.normalize(raw);
      } catch {
        // Номер разбирается теми же правилами, что и везде (ТЗ 3.1): файл
        // с локальным «901234567» должен ложиться на E.164 из базы.
        errors.push({ line: record.line, phone: raw, reason: 'Телефон не распознан' });
        continue;
      }

      const firstLine = seen.get(phone);
      if (firstLine !== undefined) {
        errors.push({
          line: record.line,
          phone,
          reason: `Повтор телефона из строки ${String(firstLine)}`,
        });
        continue;
      }

      seen.set(phone, record.line);
      candidates.push({ line: record.line, phone });
    }

    const found = await this.repository.findStudentsByPhones(candidates.map((row) => row.phone));
    const byPhone = new Map(found.map((student) => [student.phone, student]));

    const resolved: { line: number; phone: string; studentId: string }[] = [];
    for (const candidate of candidates) {
      const student = byPhone.get(candidate.phone);
      if (student === undefined) {
        errors.push({ ...candidate, reason: 'Студент с таким телефоном не найден' });
        continue;
      }
      resolved.push({ ...candidate, studentId: student.id });
    }

    await this.collectMembershipErrors(group, resolved, errors);

    if (errors.length > 0) {
      throw new BusinessRuleException('Импорт отклонён: файл содержит ошибки', {
        // Число ошибок отдаётся отдельно от списка: перечислять пятьсот строк
        // в теле ответа бессмысленно, а знать, что их пятьсот, — нужно.
        errors: errors.length,
        rows: errors.sort((a, b) => a.line - b.line).slice(0, MAX_REPORTED_ERRORS),
      });
    }

    return resolved.map((row) => row.studentId);
  }

  /**
   * Те же два правила состава, что и при обычном зачислении, но привязанные
   * к строкам файла: «уже в составе» и «одно действующее членство на курс».
   * Без них импорт был бы дырой в правилах, которые держит `POST …/students`.
   */
  private async collectMembershipErrors(
    group: StudentGroup,
    resolved: { line: number; phone: string; studentId: string }[],
    errors: ImportRowError[],
  ): Promise<void> {
    if (resolved.length === 0) return;

    const studentIds = resolved.map((row) => row.studentId);
    const lineOf = new Map(resolved.map((row) => [row.studentId, row]));

    const memberships = await this.repository.findMemberships(group.id, studentIds);
    for (const membership of memberships) {
      if (membership.status !== GroupStudentStatus.ACTIVE) continue;
      const row = lineOf.get(membership.studentId);
      if (row === undefined) continue;
      errors.push({ line: row.line, phone: row.phone, reason: 'Уже учится в этой группе' });
    }

    const competing = await this.repository.findCompetingMemberships(group.courseId, studentIds, [
      group.id,
    ]);
    for (const membership of competing) {
      const row = lineOf.get(membership.studentId);
      if (row === undefined) continue;
      errors.push({
        line: row.line,
        phone: row.phone,
        reason: `Уже учится в другой группе этого курса: ${membership.group.name}`,
      });
    }
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
