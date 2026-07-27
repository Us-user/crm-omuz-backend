import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import { GroupStatus } from '@prisma/client';

import {
  BusinessRuleException,
  emptyToNull,
  emptyToNullPatch,
  formatIsoDate,
  Paginated,
  parseIsoDate,
} from '../common';
import { GraduatesService } from '../graduates/graduates.service';
// Прямым путём, а не через barrel: нужны только чистые функции правила
// (правило сессии 0007).
import type { ActivityCategoryCounts } from '../performance/performance';
import {
  ActivityCategory,
  averageScore,
  countByCategory,
  isPassing,
} from '../performance/performance';
import type {
  CreateGroupDto,
  GroupActivityDto,
  GroupDeletedDto,
  GroupDto,
  GroupQueryDto,
  UpdateGroupDto,
} from './dto';
import type { GroupActivityRows, GroupRow } from './groups.repository';
import { GroupsRepository } from './groups.repository';

/** Успеваемость действующего состава группы: счётчики ТЗ 5.5 и «Passing students». */
interface GroupActivity {
  counts: ActivityCategoryCounts;
  passingCount: number;
}

/** У группы без состава счётчики нулевые, а не отсутствующие. */
const emptyActivity = (): GroupActivity => ({ counts: countByCategory([]), passingCount: 0 });

/**
 * Учебные группы (ТЗ 5.5) — узел учебного контура: на группу будут ссылаться
 * расписание (ТЗ 5.10), журнал (ТЗ 5.8) и состав студентов.
 *
 * Правила модуля:
 *   - курс и филиал обязательны и должны существовать (422, а не 404: ресурс
 *     из пути найден, не найдено то, что пришло в теле);
 *   - название уникально **внутри филиала**, без учёта регистра (409) — как
 *     у аудиторий: «Frontend-1» набирают в каждом филиале;
 *   - дата окончания не может быть раньше даты начала (400).
 */
@Injectable()
export class GroupsService {
  private readonly logger = new Logger(GroupsService.name);

  constructor(
    private readonly repository: GroupsRepository,
    private readonly graduates: GraduatesService,
  ) {}

  async findAll(query: GroupQueryDto): Promise<Paginated<GroupDto>> {
    const { rows, total } = await this.repository.findMany({
      search: query.search,
      branchId: query.branchId,
      courseId: query.courseId,
      status: query.status,
      format: query.format,
      sort: query.sort,
      order: query.order,
      skip: query.skip,
      take: query.take,
    });

    const activity = await this.activityOf(rows.map(({ id }) => id));

    return Paginated.from(
      rows.map((row) => toDto(row, activity.get(row.id) ?? emptyActivity())),
      total,
      query,
    );
  }

  async findOne(id: string): Promise<GroupDto> {
    const group = await this.require(id);
    const activity = await this.activityOf([group.id]);

    return toDto(group, activity.get(group.id) ?? emptyActivity());
  }

  async create(dto: CreateGroupDto): Promise<GroupDto> {
    await this.assertCourseExists(dto.courseId);
    await this.assertBranchExists(dto.branchId);
    await this.assertNameFree(dto.branchId, dto.name);

    const startDate = optionalDate(dto.startDate, 'startDate');
    const endDate = optionalDate(dto.endDate, 'endDate');
    assertPeriodOrdered(startDate, endDate);

    const durationValue = dto.durationValue ?? null;
    assertDurationPaired(durationValue, dto.durationUnit);

    const group = await this.repository.create({
      name: dto.name,
      description: emptyToNull(dto.description),
      courseId: dto.courseId,
      branchId: dto.branchId,
      format: dto.format,
      startDate,
      endDate,
      durationValue,
      durationUnit: dto.durationUnit,
      capacity: dto.capacity ?? null,
      status: dto.status,
      telegramUrl: emptyToNull(dto.telegramUrl),
    });

    this.logger.log(
      `Создана группа ${group.name} (курс ${group.course.title}, филиал ${group.branch.name}, ${group.id})`,
    );

    // Состава у только что созданной группы нет по определению — считать нечего.
    return toDto(group, emptyActivity());
  }

  async update(id: string, dto: UpdateGroupDto): Promise<GroupDto> {
    const existing = await this.require(id);

    if (dto.courseId !== undefined && dto.courseId !== existing.course.id) {
      await this.assertCourseExists(dto.courseId);
    }

    // Филиал берётся из запроса, если его меняют, иначе — текущий: тёзку нужно
    // искать там, где группа окажется после правки, а не в прежнем филиале.
    const branchId = dto.branchId ?? existing.branch.id;
    const branchChanged = branchId !== existing.branch.id;
    if (branchChanged) {
      await this.assertBranchExists(branchId);
    }

    if (dto.name !== undefined || branchChanged) {
      await this.assertNameFree(branchId, dto.name ?? existing.name, id);
    }

    if (branchChanged) {
      await this.assertScheduleFreeOfRooms(id);
    }

    // Сроки проверяются в том виде, в котором группа окажется после правки:
    // передан может быть только один из двух, и сравнивать его нужно с тем,
    // что уже лежит в БД, а не с пустотой.
    const startDate =
      dto.startDate === undefined ? existing.startDate : optionalDate(dto.startDate, 'startDate');
    const endDate =
      dto.endDate === undefined ? existing.endDate : optionalDate(dto.endDate, 'endDate');
    assertPeriodOrdered(startDate, endDate);

    const durationValue = dto.durationValue ?? existing.durationValue;
    assertDurationPaired(durationValue, dto.durationUnit);

    const group = await this.repository.update(id, {
      name: dto.name,
      description: emptyToNullPatch(dto.description),
      courseId: dto.courseId,
      branchId: dto.branchId,
      format: dto.format,
      startDate: dto.startDate === undefined ? undefined : startDate,
      endDate: dto.endDate === undefined ? undefined : endDate,
      durationValue: dto.durationValue,
      durationUnit: dto.durationUnit,
      capacity: dto.capacity,
      status: dto.status,
      telegramUrl: emptyToNullPatch(dto.telegramUrl),
    });

    this.logger.log(`Изменена группа ${group.name} (${group.id})`);

    await this.graduateIfFinished(group.id, group.status);

    const activity = await this.activityOf([group.id]);

    return toDto(group, activity.get(group.id) ?? emptyActivity());
  }

  /**
   * Автовыпуск (ТЗ 5.11: «автовыпуск при завершении срока группы курса
   * с флагом Is last course»).
   *
   * Событием выбрана **смена статуса группы на `FINISHED`**, а не наступление
   * `endDate` (решение пользователя, сессия 0026): фоновой задачи для этого
   * не нужно, а работающих в проекте нет ни одной до Фазы 11. Само правило
   * («последний ли это курс», «кого выпускать», «какой у него балл») живёт
   * в `GraduatesService` — группы лишь сообщают о событии.
   *
   * Проверяется **итоговое** состояние, а не переход: повторное сохранение
   * завершённой группы безвредно (студент выпускается из группы ровно один раз,
   * это держит уникальный индекс), зато сохранение группы, закрытой до
   * появления автовыпуска, доводит дело до конца. Тем же свойством операция
   * становится восстановимой — приём сессии 0014 с пересчётом статусов.
   *
   * Выпуск идёт **после** правки группы, а не в её транзакции: иначе правило
   * предметной области уехало бы в слой данных, а его вызов остался бы
   * непроверяемым (репозитории в проекте подменены в e2e). Цена честная и
   * названа в логе сессии: сбой между шагами оставит группу завершённой без
   * выпускников, и чинится это повторным сохранением.
   */
  private async graduateIfFinished(groupId: string, status: GroupStatus): Promise<void> {
    if (status !== GroupStatus.FINISHED) return;

    const result = await this.graduates.graduateGroup(groupId);
    if (result === null || result.graduated === 0) return;

    this.logger.log(
      `Автовыпуск группы ${groupId}: выпускников ${String(result.graduated)} (ТЗ 5.11)`,
    );
  }

  /**
   * Удаление группы. Группу с составом удалить нельзя (обещание сессий 0008–0009):
   * членство уходило бы каскадом, а вместе с ним — учебная история студента,
   * причина и дата ухода (ТЗ 5.12). Та же проверка «к записи привязаны…», что
   * уже стоит в филиалах и курсах.
   *
   * Назначения менторов, видимость уроков и расписание, наоборот, уходят каскадом
   * и отказа не вызывают: это части группы, а не самостоятельные записи со своей
   * историей. Аудитории при этом остаются — каскад уносит слоты, а не комнаты.
   */
  async remove(id: string): Promise<GroupDeletedDto> {
    const group = await this.require(id);
    await this.assertNoStudents(id);
    await this.assertNoGraduates(id);

    await this.repository.delete(id);
    this.logger.log(`Удалена группа ${group.name} (${id})`);

    return { id: group.id, name: group.name };
  }

  /**
   * Счётчики категорий активности и «Passing students» (ТЗ 5.5) для групп ответа.
   *
   * Считаются по действующему составу: категория описывает того, кто учится
   * в группе сейчас, а покинувший её больше не характеризует. Балл берётся
   * **в разрезе группы** — по её закрытым неделям (решение сессии 0019).
   *
   * Студент действующего состава, у которого в этой группе нет ни одной
   * закрытой недели, попадает в `unscored`, а не в Black list: «не оценён»
   * и «не справляется» — разные вещи, и вторая испортила бы отчёт по группе,
   * которая просто ещё не дошла до первой финализации.
   */
  private async activityOf(groupIds: string[]): Promise<Map<string, GroupActivity>> {
    if (groupIds.length === 0) return new Map();

    const rows = await this.repository.findActivity(groupIds);
    const sums = sumsByGroupStudent(rows);

    return new Map(
      groupIds.map((groupId) => {
        const scores = rows.members
          .filter((member) => member.groupId === groupId)
          .map((member) => averageScore(sums.get(keyOf(groupId, member.studentId)) ?? []));

        return [
          groupId,
          { counts: countByCategory(scores), passingCount: scores.filter(isPassing).length },
        ];
      }),
    );
  }

  private async require(id: string): Promise<GroupRow> {
    const group = await this.repository.findById(id);
    if (!group) {
      throw new NotFoundException('Группа не найдена');
    }

    return group;
  }

  private async assertBranchExists(branchId: string): Promise<void> {
    const branch = await this.repository.findBranch(branchId);
    if (!branch) {
      throw new BusinessRuleException('Филиал не найден', { branchId });
    }
  }

  private async assertCourseExists(courseId: string): Promise<void> {
    const course = await this.repository.findCourse(courseId);
    if (!course) {
      throw new BusinessRuleException('Курс не найден', { courseId });
    }
  }

  private async assertNameFree(branchId: string, name: string, exceptId?: string): Promise<void> {
    const twin = await this.repository.findByName(branchId, name);
    if (twin && twin.id !== exceptId) {
      throw new ConflictException(`Группа «${twin.name}» в этом филиале уже есть`);
    }
  }

  /**
   * Перенос в другой филиал упирается в расписание: аудитория обязана быть
   * в филиале группы (`GroupScheduleService`), а комнаты вместе с группой
   * не переезжают. Молча снять аудитории со всех занятий нельзя — расписание
   * потеряло бы места проведения, и никто бы об этом не узнал.
   */
  private async assertScheduleFreeOfRooms(groupId: string): Promise<void> {
    const slots = await this.repository.countScheduleSlotsWithRoom(groupId);
    if (slots === 0) return;

    throw new BusinessRuleException(
      `Занятия группы стоят в аудиториях текущего филиала (${String(slots)}) — ` +
        'уберите аудитории из расписания перед переносом',
      { scheduleSlots: slots },
    );
  }

  /**
   * 409, а не 422: удалению мешает существующая связь, и ответ здесь тот же,
   * что у филиала с аудиториями и курса с группами.
   *
   * Считаются все членства, а не только действующие: закрытая строка («ушёл»,
   * «завершил», «переведён») — это и есть учебная история, ради которой она
   * не удаляется при смене статуса.
   */
  private async assertNoStudents(groupId: string): Promise<void> {
    const students = await this.repository.countStudents(groupId);
    if (students === 0) return;

    throw new ConflictException(
      `В составе группы есть студенты (${String(students)}) — уберите их из состава ` +
        'перед удалением: вместе с группой исчезла бы их учебная история',
    );
  }

  /**
   * Группу, из которой кто-то выпустился, удалить нельзя (ТЗ 5.11).
   *
   * Внешний ключ у `Graduate.groupId` стоит `RESTRICT`, то есть БД такое
   * удаление и так не пропустит, — проверка нужна ради причины в ответе,
   * а не ради целостности (то же соображение, что у ступени ментора
   * с проставленными месяцами, 0021). Отдельно от состава: членство можно
   * убрать из группы руками, а выпуск и выданный по нему сертификат остаются.
   */
  private async assertNoGraduates(groupId: string): Promise<void> {
    const graduates = await this.repository.countGraduates(groupId);
    if (graduates === 0) return;

    throw new ConflictException(
      `Из группы выпустились студенты (${String(graduates)}) — вместе с ней исчезли бы ` +
        'записи о выпуске и выданные сертификаты',
    );
  }
}

/** Пустая строка — «поле очистить», как у текстовых полей формы. */
const optionalDate = (value: string | undefined, field: string): Date | null =>
  value === undefined || value === '' ? null : parseIsoDate(value, field);

/**
 * Порядок сроков. 400, а не 422: это противоречие внутри самого запроса,
 * а не нарушение правила предметной области — тем же кодом отвечает разбор
 * несуществующей даты (`parseIsoDate`).
 */
function assertPeriodOrdered(startDate: Date | null, endDate: Date | null): void {
  if (startDate === null || endDate === null) return;
  if (endDate.getTime() >= startDate.getTime()) return;

  throw new BadRequestException({
    message: 'Дата окончания раньше даты начала',
    details: { endDate: `Не может быть раньше ${formatIsoDate(startDate)}` },
  });
}

/**
 * Единица длительности без самой длительности ничего не значит: в БД осталась
 * бы группа «в месяцах», но неизвестно во сколько. Проверяется по итоговому
 * состоянию — при правке число может уже лежать в базе.
 */
function assertDurationPaired(durationValue: number | null, durationUnit?: string): void {
  if (durationUnit === undefined || durationValue !== null) return;

  throw new BadRequestException({
    message: 'Единица длительности задана без значения',
    details: { durationValue: 'Обязательно, если передан durationUnit' },
  });
}

const keyOf = (groupId: string, studentId: string): string => `${groupId}:${studentId}`;

/** Итоги закрытых недель, сведённые к паре «группа + студент». */
function sumsByGroupStudent(rows: GroupActivityRows): Map<string, number[]> {
  const sums = new Map<string, number[]>();

  for (const result of rows.results) {
    const key = keyOf(result.groupId, result.studentId);
    const existing = sums.get(key) ?? [];
    existing.push(result.sum);
    sums.set(key, existing);
  }

  return sums;
}

/**
 * Счётчики наружу именами полей, а не значениями enum: `CHAT_GPT` в ключе JSON
 * читался бы хуже, а перечисление здесь одно и покрыто тестом — разъехаться
 * с категориями оно не может.
 */
const toActivityDto = (counts: ActivityCategoryCounts): GroupActivityDto => ({
  chatGpt: counts[ActivityCategory.ChatGpt],
  handsome: counts[ActivityCategory.Handsome],
  advanced: counts[ActivityCategory.Advanced],
  kettle: counts[ActivityCategory.Kettle],
  blackList: counts[ActivityCategory.BlackList],
  unscored: counts.unscored,
});

const toDto = (row: GroupRow, activity: GroupActivity): GroupDto => ({
  id: row.id,
  name: row.name,
  description: row.description,
  course: row.course,
  branch: row.branch,
  format: row.format,
  // Столбцы `@db.Date`: наружу уходит календарная дата без времени.
  startDate: row.startDate === null ? null : formatIsoDate(row.startDate),
  endDate: row.endDate === null ? null : formatIsoDate(row.endDate),
  durationValue: row.durationValue,
  durationUnit: row.durationUnit,
  capacity: row.capacity,
  enrolledCount: row._count.students,
  passingCount: activity.passingCount,
  activity: toActivityDto(activity.counts),
  status: row.status,
  telegramUrl: row.telegramUrl,
  createdAt: row.createdAt.toISOString(),
});
