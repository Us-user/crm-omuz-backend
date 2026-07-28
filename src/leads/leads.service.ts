import { Injectable, Logger, NotFoundException } from '@nestjs/common';

import {
  BusinessRuleException,
  emptyToNull,
  emptyToNullPatch,
  formatCsv,
  formatDayTime,
  formatIsoDate,
  formatIsoMonth,
  nextIsoMonth,
  Paginated,
  parseDayTime,
  parseIsoDate,
  parseIsoMonth,
} from '../common';
import { PhoneService } from '../phone';
import type {
  CreatedLeadDto,
  CreateLeadDto,
  ExportLeadsQueryDto,
  LeadDeletedDto,
  LeadDto,
  LeadQueryDto,
  LeadsTransferredDto,
  TransferLeadsDto,
  UpdateLeadDto,
} from './dto';
import { becameClientAtOf } from './leads';
import { LEADS_CSV_HEADER, toCsvRow } from './leads.csv';
import type { LeadFilter, LeadRow, LeadTransferWrite } from './leads.repository';
import { LeadsRepository } from './leads.repository';
import { planLeadTransfers, studentProfileOf } from './leads-transfer';

/** Готовый файл выгрузки: контроллеру остаётся проставить заголовки. */
export interface LeadsCsvFile {
  content: string;
  fileName: string;
  /** Имя без кириллицы — для заголовка `Content-Disposition` старых клиентов. */
  asciiFileName: string;
  rows: number;
}

/**
 * Доменные фильтры воронки — общие у постраничного списка и у выгрузки.
 * Тип собран из `LeadQueryDto`, а не описан заново: разъехавшись, два набора
 * полей дали бы экран и файл с разным отбором (правило 0013).
 */
type LeadFilterQuery = Pick<
  LeadQueryDto,
  | 'type'
  | 'courseId'
  | 'branchId'
  | 'couponId'
  | 'enrollMonth'
  | 'converted'
  | 'from'
  | 'to'
  | 'search'
>;

/**
 * Лиды и клиенты (ТЗ 5.7).
 *
 * Маркетинговый контур проекта и жизненный цикл из ТЗ 1 целиком: «Лид (реклама) →
 * Client (после пробного дня) → Студент». Стадия хранится типом (`LEAD`/`CLIENT`)
 * вместе с датой перехода — выдуманной машины состояний воронки здесь нет,
 * потому что ТЗ такого перечисления не даёт, а на выдуманные статусы завязались
 * бы отчёты Фазы 10.
 *
 * Правый конец цепочки — `transfer`: он заводит профиль студента (или привязывает
 * существующий) и оставляет обращение на месте со ссылкой на профиль.
 */
@Injectable()
export class LeadsService {
  private readonly logger = new Logger(LeadsService.name);

  constructor(
    private readonly repository: LeadsRepository,
    private readonly phones: PhoneService,
  ) {}

  async findAll(query: LeadQueryDto): Promise<Paginated<LeadDto>> {
    const { rows, total } = await this.repository.findMany({
      ...filterOf(query),
      sort: query.sort,
      order: query.order,
      skip: query.skip,
      take: query.take,
    });

    return Paginated.from(rows.map(toDto), total, query);
  }

  async findOne(id: string): Promise<LeadDto> {
    return toDto(await this.require(id));
  }

  /**
   * Создание лида (ТЗ 5.7).
   *
   * Телефон нормализуется в E.164, но **не проверяется на занятость**: одно
   * и то же обращение может повториться через полгода, и вторая строка — это
   * второй лид, а не дубликат (запрет вычёркивал бы его из воронки). Вместо
   * отказа в ответ уходит `duplicatePhoneCount`: молчать тоже нельзя, иначе
   * оператор заведёт третью карточку и посчитает её новым обращением.
   */
  async create(dto: CreateLeadDto): Promise<CreatedLeadDto> {
    const phone = this.phones.normalize(dto.phone, 'phone');
    await this.assertRefs(dto.courseId, dto.couponId, dto.branchId);

    const lead = await this.repository.create({
      firstName: dto.firstName,
      lastName: dto.lastName,
      phone,
      email: emptyToNull(dto.email),
      birthDate: optionalDate(dto.birthDate, 'birthDate'),
      gender: dto.gender ?? null,
      occupation: emptyToNull(dto.occupation),
      enrollMonth: optionalMonth(dto.enrollMonth, 'enrollMonth'),
      courseId: emptyToNull(dto.courseId),
      lessonTimeMinute: optionalTime(dto.lessonTime, 'lessonTime'),
      notes: emptyToNull(dto.notes),
      source: emptyToNull(dto.source),
      utmSource: emptyToNull(dto.utmSource),
      utmMedium: emptyToNull(dto.utmMedium),
      utmCampaign: emptyToNull(dto.utmCampaign),
      couponId: emptyToNull(dto.couponId),
      branchId: emptyToNull(dto.branchId),
      type: dto.type,
      // Заведённый сразу клиентом (пришёл на пробный день и остался) получает
      // дату перехода тем же правилом, что и переведённый позже.
      becameClientAt: becameClientAtOf('LEAD', dto.type, new Date()),
    });

    const duplicatePhoneCount = await this.repository.countByPhone(phone, lead.id);

    this.logger.log(
      `Заведён лид ${fullName(lead)} (${lead.id}), телефон ${phone}` +
        (duplicatePhoneCount === 0
          ? ''
          : `; прежних обращений с этим номером: ${String(duplicatePhoneCount)}`),
    );

    return { ...toDto(lead), duplicatePhoneCount };
  }

  /**
   * Правка карточки (ТЗ 5.7). Смена стадии — обычная правка, но с побочным
   * действием: переход в `CLIENT` проставляет дату, возврат в `LEAD` её снимает
   * (`becameClientAtOf`). Отдельного маршрута «отметить клиентом» ТЗ не даёт,
   * а два способа сделать одно и то же разошлись бы.
   */
  async update(id: string, dto: UpdateLeadDto): Promise<LeadDto> {
    const existing = await this.require(id);
    await this.assertRefs(dto.courseId, dto.couponId, dto.branchId);

    const lead = await this.repository.update(id, {
      firstName: dto.firstName,
      lastName: dto.lastName,
      // Телефон обязателен: пустая строка прошла бы через `normalizeOptional`
      // как `undefined` и молча оставила бы прежний номер (правило 0014).
      phone: dto.phone === undefined ? undefined : this.phones.normalize(dto.phone, 'phone'),
      email: emptyToNullPatch(dto.email),
      birthDate: optionalDatePatch(dto.birthDate, 'birthDate'),
      gender: dto.gender,
      occupation: emptyToNullPatch(dto.occupation),
      enrollMonth: optionalMonthPatch(dto.enrollMonth, 'enrollMonth'),
      courseId: emptyToNullPatch(dto.courseId),
      lessonTimeMinute: optionalTimePatch(dto.lessonTime, 'lessonTime'),
      notes: emptyToNullPatch(dto.notes),
      source: emptyToNullPatch(dto.source),
      utmSource: emptyToNullPatch(dto.utmSource),
      utmMedium: emptyToNullPatch(dto.utmMedium),
      utmCampaign: emptyToNullPatch(dto.utmCampaign),
      couponId: emptyToNullPatch(dto.couponId),
      branchId: emptyToNullPatch(dto.branchId),
      type: dto.type,
      becameClientAt: becameClientAtOf(existing.type, dto.type, new Date()),
    });

    this.logger.log(
      `Изменён лид ${fullName(lead)} (${id})` +
        (dto.type === undefined || dto.type === existing.type
          ? ''
          : `, стадия: ${existing.type} → ${dto.type}`),
    );

    return toDto(lead);
  }

  /**
   * Удаление лида. Ограничений нет намеренно — и это осознанно расходится
   * с филиалами, курсами и студентами, где действует «запись с историей
   * не удаляется».
   *
   * Причина в том, что лид **сам** является ошибочной записью чаще любой другой
   * сущности проекта: ошиблись номером, звонок оказался рекламой, человек
   * попросил себя удалить. Держать такие строки вечно значило бы засорять
   * воронку, по которой считают отдачу рекламы.
   *
   * Побочная выгода: удаление лида — законный способ освободить профиль
   * студента, переведённого по ошибке (`convertedStudentId` стоит `RESTRICT`,
   * см. схему).
   */
  async remove(id: string): Promise<LeadDeletedDto> {
    const lead = await this.require(id);

    await this.repository.delete(id);
    this.logger.log(`Удалён лид ${fullName(lead)} (${id})`);

    return { id: lead.id, name: fullName(lead) };
  }

  /**
   * Перевод лидов в студенты (ТЗ 5.7: «Transfer в студенты (bulk/по строке)») —
   * правый конец жизненного цикла из ТЗ 1.
   *
   * Обращение при переводе **не удаляется**: оно хранит ссылку на профиль
   * (`convertedStudentId`), иначе на вопросы «сколько лидов сентября стали
   * студентами» и «из какой рекламы пришёл этот студент» (ТЗ 5.2) отвечать
   * было бы нечем — воронка теряла бы ровно тот конец, ради которого её считают.
   *
   * Телефон, уже занятый студентом, отказом не является: профиль не заводится
   * второй раз, а обращение привязывается к существующему (`linked`). Правило
   * целиком живёт в чистой функции `planLeadTransfers`.
   *
   * Пачка применяется целиком или не применяется вовсе (решение пользователя):
   * любая непереводимая строка — 422 с отчётом `{ leadId, reason }`, и в БД
   * при этом не записано ничего. То же, что импорт состава (0013).
   */
  async transfer(dto: TransferLeadsDto): Promise<LeadsTransferredDto> {
    const leads = await this.repository.findManyForTransfer(dto.leadIds);
    const byId = new Map(leads.map((lead) => [lead.id, lead]));

    // Профили ищутся только по номерам **найденных** обращений: спрашивать БД
    // о телефонах, которых нет, значило бы делать запрос ради пустого ответа.
    const students = await this.repository.findStudentsByPhones([
      ...new Set(leads.map((lead) => lead.phone)),
    ]);

    const { planned, rejected } = planLeadTransfers(dto.leadIds, leads, students);

    if (rejected.length > 0) {
      throw new BusinessRuleException('Перевести можно не все обращения', {
        rejected,
        total: rejected.length,
      });
    }

    const writes: LeadTransferWrite[] = planned.map((plan) => ({
      leadId: plan.leadId,
      studentId: plan.studentId,
      profile: studentProfileOf(byId.get(plan.leadId)!),
    }));

    const results = await this.repository.transfer(writes, new Date());
    const actionOf = new Map(planned.map((plan) => [plan.leadId, plan.action]));

    const transferred = results.map(({ leadId, studentId }) => ({
      leadId,
      name: fullName(byId.get(leadId)!),
      studentId,
      action: actionOf.get(leadId)!,
    }));

    const created = transferred.filter(({ action }) => action === 'created').length;

    this.logger.log(
      `Переведено обращений: ${String(transferred.length)} ` +
        `(заведено профилей ${String(created)}, привязано ${String(transferred.length - created)})`,
    );

    return { transferred, created, linked: transferred.length - created };
  }

  /**
   * Выгрузка лидов в CSV (ТЗ 5.7: «Export»).
   *
   * Тем же кодом, что выгрузка состава группы (`src/common/csv`, 0013), а не
   * вторым: сессия 0013 прямо это записала, и два разбора CSV разошлись бы
   * в мелочах (разделитель, BOM, экранирование формул) — то есть один из файлов
   * однажды открылся бы неправильно.
   *
   * Выгружается **весь отобранный набор**, а не страница: файл из двадцати
   * строк не является выгрузкой воронки. Потолок при этом есть (`MAX_EXPORT_ROWS`).
   */
  async exportCsv(query: ExportLeadsQueryDto): Promise<LeadsCsvFile> {
    const rows = await this.repository.findAllForExport(filterOf(query));

    const content = formatCsv([LEADS_CSV_HEADER, ...rows.map(toCsvRow)], { bom: true });
    const date = formatIsoDate(new Date());

    this.logger.log(`Выгружены лиды: строк ${String(rows.length)}`);

    return {
      content,
      fileName: `Лиды ${date}.csv`,
      asciiFileName: `leads-${date}.csv`,
      rows: rows.length,
    };
  }

  private async require(id: string): Promise<LeadRow> {
    const lead = await this.repository.findById(id);
    if (!lead) {
      throw new NotFoundException('Лид не найден');
    }

    return lead;
  }

  /**
   * Ссылки формы проверяются до записи: 422, а не 404, — ресурс из пути найден
   * (или создаётся), не найдено то, что пришло в теле. То же правило, что при
   * назначении ролей (0006), ссылке на филиал в группе (0008) и «Show to group»
   * (0009). Пустая строка означает «снять привязку» и до проверки не доходит.
   */
  private async assertRefs(courseId?: string, couponId?: string, branchId?: string): Promise<void> {
    if (courseId !== undefined && courseId !== '') {
      if ((await this.repository.findCourse(courseId)) === null) {
        throw new BusinessRuleException('Курс не найден', { courseId });
      }
    }

    if (couponId !== undefined && couponId !== '') {
      if ((await this.repository.findCoupon(couponId)) === null) {
        throw new BusinessRuleException('Купон не найден', { couponId });
      }
    }

    if (branchId !== undefined && branchId !== '') {
      if ((await this.repository.findBranch(branchId)) === null) {
        throw new BusinessRuleException('Филиал не найден', { branchId });
      }
    }
  }
}

const fullName = (row: { lastName: string; firstName: string }): string =>
  `${row.lastName} ${row.firstName}`;

/**
 * Разбор доменных фильтров воронки — один на список и на выгрузку.
 *
 * Месяцы разбираются здесь, а не в репозитории: негодный `2026-13` должен
 * отвечать 400 **до** запроса в БД, а не превращаться в `Invalid Date`,
 * который Prisma отдаст пятисоткой (приём 0021, 0025, 0026).
 */
const filterOf = (query: LeadFilterQuery): LeadFilter => ({
  type: query.type,
  courseId: query.courseId,
  branchId: query.branchId,
  couponId: query.couponId,
  enrollMonth:
    query.enrollMonth === undefined ? undefined : parseIsoMonth(query.enrollMonth, 'enrollMonth'),
  converted: query.converted,
  from: query.from === undefined ? undefined : parseIsoMonth(query.from, 'from'),
  // Правая граница периода — первое число следующего месяца, и она **не**
  // включающая: «по июнь» означает весь июнь, а не его первое число.
  to: query.to === undefined ? undefined : nextIsoMonth(parseIsoMonth(query.to, 'to')),
  search: query.search,
});

/** Пустая строка очищает поле, отсутствие поля — оставляет как есть. */
const optionalDate = (value: string | undefined, field: string): Date | null =>
  value === undefined || value === '' ? null : parseIsoDate(value, field);

const optionalDatePatch = (value: string | undefined, field: string): Date | null | undefined =>
  value === undefined ? undefined : optionalDate(value, field);

const optionalMonth = (value: string | undefined, field: string): Date | null =>
  value === undefined || value === '' ? null : parseIsoMonth(value, field);

const optionalMonthPatch = (value: string | undefined, field: string): Date | null | undefined =>
  value === undefined ? undefined : optionalMonth(value, field);

const optionalTime = (value: string | undefined, field: string): number | null =>
  value === undefined || value === '' ? null : parseDayTime(value, field);

const optionalTimePatch = (value: string | undefined, field: string): number | null | undefined =>
  value === undefined ? undefined : optionalTime(value, field);

const toDto = (row: LeadRow): LeadDto => ({
  id: row.id,
  firstName: row.firstName,
  lastName: row.lastName,
  phone: row.phone,
  email: row.email,
  // Столбцы `@db.Date`: наружу уходит календарная дата без времени, а месяц —
  // без дня (в столбце он всегда первый и смысла не несёт).
  birthDate: row.birthDate === null ? null : formatIsoDate(row.birthDate),
  gender: row.gender,
  occupation: row.occupation,
  enrollMonth: row.enrollMonth === null ? null : formatIsoMonth(row.enrollMonth),
  course: row.course === null ? null : { id: row.course.id, name: row.course.title },
  lessonTime: row.lessonTimeMinute === null ? null : formatDayTime(row.lessonTimeMinute),
  notes: row.notes,
  source: row.source,
  utm: { source: row.utmSource, medium: row.utmMedium, campaign: row.utmCampaign },
  coupon: row.coupon,
  branch: row.branch,
  type: row.type,
  becameClientAt: row.becameClientAt === null ? null : row.becameClientAt.toISOString(),
  conversion: {
    converted: row.convertedStudentId !== null,
    studentId: row.convertedStudentId,
    convertedAt: row.convertedAt === null ? null : row.convertedAt.toISOString(),
  },
  createdAt: row.createdAt.toISOString(),
});
