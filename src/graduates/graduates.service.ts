import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { GraduateEmployment } from '@prisma/client';

import {
  BusinessRuleException,
  emptyToNullPatch,
  formatIsoDate,
  nextIsoMonth,
  Paginated,
  parseIsoDate,
  parseIsoMonth,
} from '../common';
import { PdfGeneratorService } from '../documents/pdf-generator.service';
// Прямым путём, а не через barrel: нужны только чистые функции правила
// (правило сессии 0007).
import type { ActivityCategory } from '../performance/performance';
import {
  ACTIVITY_CATEGORY_TITLES,
  activityCategoryOf,
  roundScore,
} from '../performance/performance';
import { deriveStudentStatus } from '../students/student-status';
import type {
  GraduateDto,
  GraduateEmploymentCountsDto,
  GraduatesQueryDto,
  GraduationResultDto,
  IssueCertificateDto,
  UpdateGraduateDto,
} from './dto';
import type { GraduateEmploymentCounts } from './graduates';
import { employmentCountsOf, graduationDateOf } from './graduates';
import type {
  GraduateFilter,
  GraduateInput,
  GraduateRow,
  StudentStatusUpdate,
} from './graduates.repository';
import { GraduatesRepository } from './graduates.repository';

/**
 * Причина закрытия членства при автовыпуске (ТЗ 5.5 требует Reason у любой
 * смены статуса состава). Текст один на все выпуски и задан константой:
 * оператор его не вводит, потому что действие не «отчислить», а «группа
 * доучилась», и объяснять тут нечего.
 */
export const GRADUATION_STATUS_REASON = 'Группа завершила обучение: автовыпуск';

/**
 * Выпускники (ТЗ 5.11).
 *
 * Записи заводит **автовыпуск**: когда группа курса с флагом «Is last course»
 * переводится в статус `FINISHED`, её действующий состав закрывается как
 * `FINISHED`, а на каждого студента заводится строка выпуска. Событием выбрана
 * смена статуса, а не наступление `endDate` (решение пользователя, сессия
 * 0026): фоновой задачи для этого не нужно, а работающих в проекте нет
 * до Фазы 11 — то же соображение, по которому месяц закрывают руками (0024),
 * а отчёт Директору не уходит в очередь (0018).
 *
 * Витрина при этом почти только читает: руками правятся лишь те поля, которые
 * система не выводит сама (трудоустройство, место работы, дата), и выдаётся
 * сертификат. Балл выпускника — снимок и не правится.
 */
@Injectable()
export class GraduatesService {
  private readonly logger = new Logger(GraduatesService.name);

  constructor(
    private readonly repository: GraduatesRepository,
    private readonly pdfGenerator: PdfGeneratorService,
  ) {}

  /** Список выпускников (ТЗ 5.11: «виды Students/Groups»). */
  async findAll(query: GraduatesQueryDto): Promise<Paginated<GraduateDto>> {
    const filter: GraduateFilter = {
      groupId: query.groupId,
      courseId: query.courseId,
      branchId: query.branchId,
      employment: query.employment,
      hasCertificate: query.hasCertificate,
      from: query.from === undefined ? undefined : parseIsoMonth(query.from, 'from'),
      to: query.to === undefined ? undefined : nextIsoMonth(parseIsoMonth(query.to, 'to')),
      search: query.search,
    };

    const [{ rows, total }, employment] = await Promise.all([
      this.repository.findMany({
        ...filter,
        sort: query.sort,
        order: query.order,
        skip: query.skip,
        take: query.take,
      }),
      this.employmentCounts(filter),
    ]);

    return Paginated.from(rows.map(toDto), total, query, { employment });
  }

  async findOne(id: string): Promise<GraduateDto> {
    return toDto(await this.require(id));
  }

  /** Правка карточки выпускника (ТЗ 5.11). */
  async update(id: string, dto: UpdateGraduateDto): Promise<GraduateDto> {
    const existing = await this.require(id);

    const graduate = await this.repository.update(id, {
      employment: dto.employment,
      workPlace: emptyToNullPatch(dto.workPlace),
      graduatedAt:
        dto.graduatedAt === undefined ? undefined : parseIsoDate(dto.graduatedAt, 'graduatedAt'),
    });

    this.logger.log(
      `Изменена карточка выпускника ${fullName(existing)} (${id})` +
        (dto.employment === undefined ? '' : `, трудоустройство: ${String(dto.employment)}`),
    );

    return toDto(graduate);
  }

  /**
   * Выдача сертификата (ТЗ 5.11, 3.7).
   *
   * Повторная выдача — 409, а не перезапись: второй номер поверх первого
   * означал бы, что выданный на руки диплом больше не числится в системе.
   * Ошибочную выдачу снимают `DELETE …/certificate` — тот же ход, что
   * с повторным назначением ментора (0010) и закрытием месяца (0024).
   */
  async issueCertificate(
    id: string,
    dto: IssueCertificateDto,
    accountId: string,
  ): Promise<GraduateDto> {
    const existing = await this.require(id);

    if (existing.certificateSerial !== null) {
      throw new ConflictException(
        `Сертификат уже выдан (№ ${existing.certificateSerial}) — снимите выдачу, ` +
          'если номер нужно изменить',
      );
    }

    const twin = await this.repository.findBySerial(dto.serial);
    if (twin !== null) {
      throw new ConflictException(`Сертификат № ${dto.serial} уже выдан другому выпускнику`);
    }

    const issuedById = await this.employeeIdOf(accountId);
    const graduate = await this.repository.issueCertificate(id, {
      serial: dto.serial,
      issuedAt: dto.issuedAt === undefined ? today() : parseIsoDate(dto.issuedAt, 'issuedAt'),
      issuedById,
    });

    this.logger.log(`Выдан сертификат № ${dto.serial}: ${fullName(existing)} (${id})`);

    return toDto(graduate);
  }

  /**
   * Снятие выдачи — сверх перечня маршрутов ТЗ 5.11.
   *
   * Прямое следствие правила «повторная выдача — 409»: без снятия ошибочный
   * номер остался бы навсегда, а вместе с ним занятым — сам номер (он уникален
   * по всему центру). Седьмой раз тот же ход: `DELETE …/files/{fileId}` (0009),
   * `PUT` роли ментора (0010), `DELETE` из состава (0012), заметка о студенте
   * (0015), уровень месяца (0021), отзыв заявки на аванс (0022), снятие
   * снимка месяца (0024).
   */
  async revokeCertificate(id: string): Promise<GraduateDto> {
    const existing = await this.require(id);

    if (existing.certificateSerial === null) {
      throw new NotFoundException('Сертификат этому выпускнику не выдавался');
    }

    const graduate = await this.repository.revokeCertificate(id);
    this.logger.log(
      `Снята выдача сертификата № ${existing.certificateSerial}: ${fullName(existing)} (${id})`,
    );

    return toDto(graduate);
  }

  /**
   * Генерация PDF-сертификата выпускника (ТЗ 3.7, 5.11).
   */
  async exportCertificate(id: string): Promise<Buffer> {
    const graduate = await this.require(id);

    if (graduate.certificateSerial === null) {
      throw new BusinessRuleException(
        'CERTIFICATE_NOT_ISSUED',
        `Для выпуска "${id}" ещё не выдан сертификат. Сначала укажите серийный номер.`,
      );
    }

    const points = toPoints(graduate.points);
    const level = activityCategoryOf(points);
    const categoryTitle = level === null ? 'Ученик' : (ACTIVITY_CATEGORY_TITLES[level] ?? 'Ученик');

    return this.pdfGenerator.generateCertificatePdf({
      serialNumber: graduate.certificateSerial,
      studentName: fullName(graduate),
      courseTitle: graduate.group.course.title,
      issueDate: graduate.certificateIssuedAt ?? graduate.graduatedAt,
      score: points ?? 0,
      activityCategory: categoryTitle,
    });
  }

  // ─────────────────────────── Автовыпуск (ТЗ 5.11) ───────────────────────────

  /**
   * Автовыпуск группы. Вызывается из `GroupsService`, когда группа оказывается
   * в статусе `FINISHED`; `null` — выпускать нечего или незачем.
   *
   * Проверяется **итоговое** состояние группы, а не переход в него: повторный
   * вызов на уже завершённой группе безвреден (уникальный индекс
   * `(groupId, studentId)`), зато сохранение группы, закрытой до появления
   * автовыпуска, доводит дело до конца. Это же делает операцию восстановимой:
   * сбой между выпуском и пересчётом статусов профилей чинится повторным
   * сохранением, а не правкой БД.
   *
   * Выпускается **действующий состав** (решение пользователя, сессия 0026):
   * ушедшие (`LEFT`) и переведённые (`TRANSFERRED`) курс не заканчивали,
   * и диплом им не полагается.
   */
  async graduateGroup(groupId: string): Promise<GraduationResultDto | null> {
    const group = await this.repository.findGroupForGraduation(groupId);
    // Флаг курса — единственное условие выпуска из ТЗ 5.11. Группа
    // промежуточного курса завершается молча: человек идёт учиться дальше.
    if (group === null || !group.course.isLastCourse) return null;

    const memberIds = await this.repository.findActiveMemberIds(groupId);
    if (memberIds.length === 0) return null;

    const graduated = new Set(await this.repository.findGraduatedStudentIds(groupId));
    const fresh = memberIds.filter((studentId) => !graduated.has(studentId));

    const rows = await this.repository.graduate(
      groupId,
      await this.inputsFor(fresh),
      memberIds,
      graduationDateOf(group.endDate, today()),
      GRADUATION_STATUS_REASON,
    );

    await this.syncProfileStatuses(memberIds);

    this.logger.log(
      `Автовыпуск группы ${group.name} (курс ${group.course.title}, ${groupId}): ` +
        `выпущено ${String(fresh.length)}, закрыто членств ${String(memberIds.length)}`,
    );

    return { groupId, graduated: fresh.length, graduates: rows.map(toDto) };
  }

  /**
   * Строки выпуска с замороженным баллом (ТЗ 5.8: «…→ Points выпускника»).
   *
   * Балл берётся тем же правилом, что рейтинг и категории, — средним по
   * финализированным неделям, — и округляется до показанного значения: снимок
   * сравнивают глазами с тем, что стояло на экране. Студент без единой закрытой
   * недели получает `null`, а не ноль: балла у него **нет**, и ноль записал бы
   * его в Black list (правило сессии 0019).
   */
  private async inputsFor(studentIds: string[]): Promise<GraduateInput[]> {
    if (studentIds.length === 0) return [];

    const scores = new Map(
      (await this.repository.findScores(studentIds)).map((score) => [score.studentId, score]),
    );

    return studentIds.map((studentId) => {
      const score = scores.get(studentId);

      return {
        studentId,
        points: score === undefined ? null : roundScore(score.average),
        weeksCount: score?.weeksCount ?? 0,
      };
    });
  }

  /**
   * Пересчёт статусов профилей (ТЗ 5.3) по правилу `deriveStudentStatus`
   * из модуля студентов. Через границу модуля переходит **чистая функция**,
   * а не сервис состава группы: тянуть `GroupStudentsService` значило бы
   * заставить каждый e2e-набор групп подменять репозиторий, которым он
   * не пользуется (критерий сессии 0006, тот же выбор, что в 0019).
   *
   * Идёт **после** транзакции выпуска — как и в сессии 0014, и по той же
   * причине: сбой между шагами оставит профиль с прежним статусом при верных
   * членствах, а это восстановимо (вывод идемпотентен). Обратный порядок
   * ошибки испортил бы сами данные.
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
      `Пересчитан статус профиля у выпускников: ${updates
        .map(({ studentId, status }) => `${studentId} → ${status}`)
        .join(', ')}`,
    );
  }

  // ────────────────────────────── Вспомогательное ─────────────────────────────

  /**
   * Счётчики трудоустройства (ТЗ 5.11) по всему отобранному набору. Они одни
   * на все страницы и уходят в `meta` — тот же случай, что баланс коинов (0018)
   * и пьедестал рейтинга (0024).
   */
  private async employmentCounts(filter: GraduateFilter): Promise<GraduateEmploymentCountsDto> {
    return toEmploymentDto(employmentCountsOf(await this.repository.countByEmployment(filter)));
  }

  private async require(id: string): Promise<GraduateRow> {
    const graduate = await this.repository.findById(id);
    if (!graduate) {
      throw new NotFoundException('Выпускник не найден');
    }

    return graduate;
  }

  /** Профиль вызывающего: `null` — у аккаунта нет профиля сотрудника. */
  private async employeeIdOf(accountId: string): Promise<string | null> {
    const employee = await this.repository.findEmployeeByAccount(accountId);

    return employee?.id ?? null;
  }
}

/**
 * Полночь сегодняшнего дня по UTC. Колонки `graduatedAt` и `certificateIssuedAt`
 * объявлены `@db.Date`: времени в них нет, и приводить его к полуночи должен
 * тот, кто про это знает, — иначе значение зависело бы от часа отправки запроса.
 *
 * Часовой пояс центра (UTC+5) не учитывается: весь проект работает
 * с календарём в UTC (`parseIsoDate`, `parseIsoMonth`), и второе понятие
 * «сегодня» только здесь развело бы их.
 */
const today = (): Date => {
  const now = new Date();

  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
};

const fullName = (row: GraduateRow): string => `${row.student.lastName} ${row.student.firstName}`;

/**
 * Счётчики наружу именами полей, а не значениями enum: `FURTHER_EDUCATION`
 * в ключе JSON читался бы хуже. Перечисление здесь одно и покрыто тестом —
 * разъехаться со статусами оно не может (тот же приём, что со счётчиками
 * категорий активности в списке групп, 0019).
 */
const toEmploymentDto = (counts: GraduateEmploymentCounts): GraduateEmploymentCountsDto => ({
  openToWork: counts[GraduateEmployment.OPEN_TO_WORK],
  work: counts[GraduateEmployment.WORK],
  freelancer: counts[GraduateEmployment.FREELANCER],
  furtherEducation: counts[GraduateEmployment.FURTHER_EDUCATION],
  entrepreneur: counts[GraduateEmployment.ENTREPRENEUR],
  unknown: counts.unknown,
});

/**
 * `Decimal` в число: перевод через `Number()`, а не `Decimal.toNumber()`, —
 * так же корректно, но не падает, когда слой данных подменён (приём сессии 0007).
 */
const toPoints = (points: GraduateRow['points']): number | null =>
  points === null ? null : Number(points);

const toDto = (row: GraduateRow): GraduateDto => {
  const points = toPoints(row.points);
  // «Level» выводится из **замороженного** балла той же функцией, что категория
  // активности: пока `points` снимок, снимок и уровень.
  const level: ActivityCategory | null = activityCategoryOf(points);

  return {
    id: row.id,
    student: row.student,
    group: { id: row.group.id, name: row.group.name },
    course: { id: row.group.course.id, name: row.group.course.title },
    branch: row.group.branch,
    // Столбцы `@db.Date`: наружу уходит календарная дата без времени.
    graduatedAt: formatIsoDate(row.graduatedAt),
    points,
    weeksCount: row.weeksCount,
    level,
    levelTitle: level === null ? null : ACTIVITY_CATEGORY_TITLES[level],
    employment: row.employment,
    workPlace: row.workPlace,
    certificate: {
      issued: row.certificateSerial !== null,
      serial: row.certificateSerial,
      issuedAt: row.certificateIssuedAt === null ? null : formatIsoDate(row.certificateIssuedAt),
      issuedBy: row.certificateIssuedBy,
    },
    createdAt: row.createdAt.toISOString(),
  };
};
