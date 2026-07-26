import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { GroupStatus, WeekDay } from '@prisma/client';

import {
  BusinessRuleException,
  emptyToNullPatch,
  formatDayTime,
  Paginated,
  parseDayTime,
} from '../common';
import type {
  CreateScheduleSlotDto,
  ScheduleSlotDto,
  ScheduleSlotQueryDto,
  ScheduleSlotRemovedDto,
  UpdateScheduleSlotDto,
} from './dto';
import type { ScheduleSlotRow, SlotGroup } from './group-schedule.repository';
import { GroupScheduleRepository } from './group-schedule.repository';

/** Дни недели по-русски — для текста отказа, а не для интерфейса. */
const WEEK_DAY_LABELS: Record<WeekDay, string> = {
  [WeekDay.MONDAY]: 'понедельник',
  [WeekDay.TUESDAY]: 'вторник',
  [WeekDay.WEDNESDAY]: 'среда',
  [WeekDay.THURSDAY]: 'четверг',
  [WeekDay.FRIDAY]: 'пятница',
  [WeekDay.SATURDAY]: 'суббота',
  [WeekDay.SUNDAY]: 'воскресенье',
};

/**
 * Группа, чьё расписание больше ни на что не претендует: обучение закончилось
 * или не начиналось. Её занятия не держат за собой ни аудиторию, ни ментора.
 */
const SETTLED_GROUP_STATUSES: GroupStatus[] = [GroupStatus.FINISHED, GroupStatus.CANCELLED];

/** Итоговое состояние слота — то, каким он станет после запроса. */
interface SlotShape {
  dayOfWeek: WeekDay;
  startMinute: number;
  endMinute: number;
  roomId: string | null;
  mentorId: string | null;
}

/**
 * Расписание группы (ТЗ 5.5: «слоты день+время → Timetable», ТЗ 5.10).
 *
 * Слот повторяется еженедельно, поэтому «занято» — это совпадение дня недели
 * и пересечение по времени у групп, чьи сроки обучения идут внахлёст.
 *
 * Правила модуля:
 *   - группа из пути должна существовать (404), слот ищется вместе с ней;
 *   - аудитория — только из филиала группы (422): комната физически стоит
 *     в своём филиале, и занятие соседнего филиала в ней не проведёшь;
 *   - ментор — только из числа менторов группы (422);
 *   - занятия не пересекаются (409) по трём причинам: у самой группы,
 *     в одной аудитории и у одного ментора.
 */
@Injectable()
export class GroupScheduleService {
  private readonly logger = new Logger(GroupScheduleService.name);

  constructor(private readonly repository: GroupScheduleRepository) {}

  async findAll(groupId: string, query: ScheduleSlotQueryDto): Promise<Paginated<ScheduleSlotDto>> {
    await this.requireGroup(groupId);

    const { rows, total } = await this.repository.findMany({
      groupId,
      search: query.search,
      dayOfWeek: query.dayOfWeek,
      roomId: query.roomId,
      mentorId: query.mentorId,
      sort: query.sort,
      order: query.order,
      skip: query.skip,
      take: query.take,
    });

    return Paginated.from(rows.map(toDto), total, query);
  }

  async create(groupId: string, dto: CreateScheduleSlotDto): Promise<ScheduleSlotDto> {
    const group = await this.requireGroup(groupId);

    const startMinute = parseDayTime(dto.startTime, 'startTime');
    const endMinute = parseDayTime(dto.endTime, 'endTime');
    assertTimesOrdered(startMinute, endMinute);

    const roomId = dto.roomId ?? null;
    const mentorId = dto.mentorId ?? null;

    if (roomId !== null) await this.assertRoomUsable(group, roomId);
    if (mentorId !== null) await this.assertMentorOfGroup(group, mentorId);

    await this.assertFree(group, {
      dayOfWeek: dto.dayOfWeek,
      startMinute,
      endMinute,
      roomId,
      mentorId,
    });

    const slot = await this.repository.create({
      groupId,
      dayOfWeek: dto.dayOfWeek,
      startMinute,
      endMinute,
      roomId,
      mentorId,
    });

    this.logger.log(
      `В расписание группы ${group.name} добавлено занятие ` +
        `${describeSlot(slot.dayOfWeek, slot.startMinute, slot.endMinute)} (${slot.id})`,
    );

    return toDto(slot);
  }

  async update(
    groupId: string,
    slotId: string,
    dto: UpdateScheduleSlotDto,
  ): Promise<ScheduleSlotDto> {
    const group = await this.requireGroup(groupId);
    const existing = await this.requireSlot(groupId, slotId);

    // Слот проверяется в том виде, в котором окажется после правки: передать
    // можно одно поле из пяти, и сверять его нужно с тем, что уже лежит в БД.
    const shape = this.resolveShape(existing, dto);
    assertTimesOrdered(shape.startMinute, shape.endMinute);

    const roomChanged = shape.roomId !== (existing.room?.id ?? null);
    const mentorChanged = shape.mentorId !== (existing.mentor?.id ?? null);

    if (roomChanged && shape.roomId !== null) await this.assertRoomUsable(group, shape.roomId);
    if (mentorChanged && shape.mentorId !== null) {
      await this.assertMentorOfGroup(group, shape.mentorId);
    }

    await this.assertFree(group, shape, slotId);

    const slot = await this.repository.update(slotId, {
      dayOfWeek: dto.dayOfWeek,
      startMinute: dto.startTime === undefined ? undefined : shape.startMinute,
      endMinute: dto.endTime === undefined ? undefined : shape.endMinute,
      roomId: dto.roomId === undefined ? undefined : shape.roomId,
      mentorId: dto.mentorId === undefined ? undefined : shape.mentorId,
    });

    this.logger.log(
      `Изменено занятие группы ${group.name}: ` +
        `${describeSlot(slot.dayOfWeek, slot.startMinute, slot.endMinute)} (${slot.id})`,
    );

    return toDto(slot);
  }

  async remove(groupId: string, slotId: string): Promise<ScheduleSlotRemovedDto> {
    const slot = await this.requireSlot(groupId, slotId);

    await this.repository.delete(slotId);
    this.logger.log(
      `Из расписания группы ${groupId} убрано занятие ` +
        `${describeSlot(slot.dayOfWeek, slot.startMinute, slot.endMinute)} (${slotId})`,
    );

    return {
      id: slot.id,
      groupId: slot.groupId,
      dayOfWeek: slot.dayOfWeek,
      startTime: formatDayTime(slot.startMinute),
      endTime: formatDayTime(slot.endMinute),
    };
  }

  // ──────────────────────────────── Правила ─────────────────────────────────

  private async requireGroup(groupId: string): Promise<SlotGroup> {
    const group = await this.repository.findGroup(groupId);
    if (!group) {
      throw new NotFoundException('Группа не найдена');
    }

    return group;
  }

  /**
   * Слот вместе с группой из пути. Группа проверяется отдельным запросом, чтобы
   * отличить «нет такой группы» от «у группы нет такого занятия»: без этого
   * опечатка в идентификаторе группы выглядела бы как пропавшее занятие.
   */
  private async requireSlot(groupId: string, slotId: string): Promise<ScheduleSlotRow> {
    const slot = await this.repository.findOne(groupId, slotId);
    if (!slot) {
      throw new NotFoundException('Занятие не найдено в расписании этой группы');
    }

    return slot;
  }

  /**
   * Аудитория из тела запроса — 422, а не 404: ресурс из пути найден, не найдено
   * (или не годится) то, что пришло в теле.
   *
   * Аудитория обязана быть в филиале группы: комната физически стоит в своём
   * филиале, и занятие соседнего филиала в ней не проведёшь. Правило обещано
   * сессией 0008 — до расписания связи «группа → комната» просто не было.
   */
  private async assertRoomUsable(group: SlotGroup, roomId: string): Promise<void> {
    const room = await this.repository.findRoom(roomId);
    if (!room) {
      throw new BusinessRuleException('Аудитория не найдена', { roomId });
    }

    if (room.branchId !== group.branchId) {
      throw new BusinessRuleException(
        `Аудитория «${room.name}» находится в другом филиале, чем группа «${group.name}»`,
        { roomId },
      );
    }
  }

  /**
   * Ментор занятия — только из состава менторов группы (`/groups/{id}/mentors`).
   * Поставить в расписание группы постороннего сотрудника нельзя: тогда «менторы
   * группы» и «кто ведёт занятия» разошлись бы, а по вторым считаются часы (ТЗ 5.16).
   */
  private async assertMentorOfGroup(group: SlotGroup, mentorId: string): Promise<void> {
    const mentor = await this.repository.findGroupMentor(group.id, mentorId);
    if (!mentor) {
      throw new BusinessRuleException(
        `Сотрудник не назначен ментором группы «${group.name}» — сначала добавьте его в менторы`,
        { mentorId },
      );
    }
  }

  /**
   * Пересечения по времени (решение пользователя, сессия 0011): проверяются все три.
   *
   * Занятия завершённых и несостоявшихся групп в расчёт не идут, как и занятия
   * групп, чьи сроки обучения не пересекаются с нашими: курс длится около месяца,
   * группы в одной аудитории сменяют друг друга — без этого условия расписание
   * новой группы упиралось бы в расписание прошлогодней.
   */
  private async assertFree(
    group: SlotGroup,
    shape: SlotShape,
    exceptSlotId?: string,
  ): Promise<void> {
    const candidates = await this.repository.findOverlapping({
      dayOfWeek: shape.dayOfWeek,
      startMinute: shape.startMinute,
      endMinute: shape.endMinute,
      exceptSlotId,
      groupId: group.id,
      ...(shape.roomId === null ? {} : { roomId: shape.roomId }),
      ...(shape.mentorId === null ? {} : { mentorId: shape.mentorId }),
    });

    const own = candidates.find((slot) => slot.groupId === group.id);
    if (own) {
      throw new ConflictException(
        `У группы уже есть занятие в это время (${describeSlot(own.dayOfWeek, own.startMinute, own.endMinute)})`,
      );
    }

    // Своё расписание группа не может переполнить в любом состоянии, а вот
    // аудиторию и ментора завершённая или отменённая группа уже не занимает.
    if (isSettled(group)) return;

    const competing = candidates.filter(
      (slot) => !isSettled(slot.group) && periodsOverlap(group, slot.group),
    );

    const busyRoom =
      shape.roomId === null ? undefined : competing.find((slot) => slot.roomId === shape.roomId);
    if (busyRoom) {
      throw new ConflictException(
        `Аудитория занята группой «${busyRoom.group.name}» ` +
          `(${describeSlot(busyRoom.dayOfWeek, busyRoom.startMinute, busyRoom.endMinute)})`,
      );
    }

    const busyMentor =
      shape.mentorId === null
        ? undefined
        : competing.find((slot) => slot.mentorId === shape.mentorId);
    if (busyMentor) {
      throw new ConflictException(
        `Ментор в это время ведёт занятие группы «${busyMentor.group.name}» ` +
          `(${describeSlot(busyMentor.dayOfWeek, busyMentor.startMinute, busyMentor.endMinute)})`,
      );
    }
  }

  /** Каким слот станет после правки: не переданное поле берётся из БД. */
  private resolveShape(existing: ScheduleSlotRow, dto: UpdateScheduleSlotDto): SlotShape {
    // Пустая строка снимает ссылку — то же правило, что у текстовых полей
    // и дат в остальных модулях: иначе поставленную по ошибке аудиторию
    // нельзя было бы убрать через `PUT` вообще.
    const roomPatch = emptyToNullPatch(dto.roomId);
    const mentorPatch = emptyToNullPatch(dto.mentorId);

    return {
      dayOfWeek: dto.dayOfWeek ?? existing.dayOfWeek,
      startMinute:
        dto.startTime === undefined
          ? existing.startMinute
          : parseDayTime(dto.startTime, 'startTime'),
      endMinute:
        dto.endTime === undefined ? existing.endMinute : parseDayTime(dto.endTime, 'endTime'),
      roomId: roomPatch === undefined ? (existing.room?.id ?? null) : roomPatch,
      mentorId: mentorPatch === undefined ? (existing.mentor?.id ?? null) : mentorPatch,
    };
  }
}

/**
 * Порядок времени. 400, а не 422: это противоречие внутри самого запроса,
 * а не нарушение правила предметной области — тем же кодом отвечают сроки
 * группы в `GroupsService`.
 *
 * Занятие нулевой длины запрещено: в расписании его не видно, а часы
 * по нему посчитались бы нулём (ТЗ 5.16).
 */
function assertTimesOrdered(startMinute: number, endMinute: number): void {
  if (endMinute > startMinute) return;

  throw new BadRequestException({
    message: 'Занятие заканчивается не позже, чем начинается',
    details: { endTime: `Должно быть позже ${formatDayTime(startMinute)}` },
  });
}

const isSettled = (group: { status: GroupStatus }): boolean =>
  SETTLED_GROUP_STATUSES.includes(group.status);

/**
 * Идут ли группы внахлёст по срокам. Незаполненный срок — открытая граница:
 * про такую группу неизвестно, когда она закончится, и считать её ушедшей
 * было бы опаснее, чем лишний раз спросить.
 */
function periodsOverlap(
  a: { startDate: Date | null; endDate: Date | null },
  b: { startDate: Date | null; endDate: Date | null },
): boolean {
  if (a.endDate !== null && b.startDate !== null && a.endDate.getTime() < b.startDate.getTime()) {
    return false;
  }
  if (b.endDate !== null && a.startDate !== null && b.endDate.getTime() < a.startDate.getTime()) {
    return false;
  }

  return true;
}

const describeSlot = (dayOfWeek: WeekDay, startMinute: number, endMinute: number): string =>
  `${WEEK_DAY_LABELS[dayOfWeek]} ${formatDayTime(startMinute)}–${formatDayTime(endMinute)}`;

const toDto = (row: ScheduleSlotRow): ScheduleSlotDto => ({
  id: row.id,
  groupId: row.groupId,
  dayOfWeek: row.dayOfWeek,
  // В БД лежат минуты от полуночи; наружу уходит время в том же виде,
  // в каком его ввели в форме.
  startTime: formatDayTime(row.startMinute),
  endTime: formatDayTime(row.endMinute),
  room: row.room,
  mentor: row.mentor,
  createdAt: row.createdAt.toISOString(),
});
