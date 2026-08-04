import { Injectable, Logger, NotFoundException } from '@nestjs/common';

import { emptyToNull, emptyToNullPatch, formatIsoDate, Paginated, parseIsoDate } from '../common';
import type {
  CreateJobDto,
  JobDeletedDto,
  JobDto,
  JobQueryDto,
  MeJobDto,
  MeJobQueryDto,
  UpdateJobDto,
} from './dto';
import { isJobOpen } from './jobs';
import type { JobRow } from './jobs.repository';
import { JobsRepository } from './jobs.repository';

/**
 * Вакансии (ТЗ 5.18).
 *
 * Самый простой модуль проекта, и это его главное свойство: вакансия
 * ни с чем не связана — у неё нет ни курса, ни филиала, ни отклика. Отсюда
 * отсутствие всего, что есть у остальных справочников: **нет проверки
 * уникальности** (одна и та же должность законно повторяется у разных
 * компаний и в разные сезоны — довод повторного обращения лида, 0027)
 * и **нет запрета на удаление** (удалять нечего, кроме самого объявления:
 * ни одна запись на него не ссылается — осознанно иначе, чем филиал с записями,
 * 0007, или купон, обещанный лиду, 0027).
 *
 * Правил остаётся ровно два: срок — включающая граница, и «актуальность»
 * выводится из статуса и срока, а не хранится.
 */
@Injectable()
export class JobsService {
  private readonly logger = new Logger(JobsService.name);

  constructor(private readonly repository: JobsRepository) {}

  async findAll(query: JobQueryDto): Promise<Paginated<JobDto>> {
    const on = today();

    const { rows, total } = await this.repository.findMany({
      search: query.search,
      status: query.status,
      open: query.open,
      on,
      sort: query.sort,
      order: query.order,
      skip: query.skip,
      take: query.take,
    });

    return Paginated.from(
      rows.map((row) => toDto(row, on)),
      total,
      query,
    );
  }

  async findOne(id: string): Promise<JobDto> {
    return toDto(await this.require(id), today());
  }

  async create(dto: CreateJobDto): Promise<JobDto> {
    const job = await this.repository.create({
      title: dto.title,
      company: dto.company,
      description: emptyToNull(dto.description),
      requirements: emptyToNull(dto.requirements),
      contacts: dto.contacts,
      deadline: optionalDate(dto.deadline, 'deadline'),
      status: dto.status,
    });

    this.logger.log(`Заведена вакансия «${job.title}» (${job.id})`);

    return toDto(job, today());
  }

  async update(id: string, dto: UpdateJobDto): Promise<JobDto> {
    await this.require(id);

    const job = await this.repository.update(id, {
      title: dto.title,
      company: dto.company,
      description: emptyToNullPatch(dto.description),
      requirements: emptyToNullPatch(dto.requirements),
      contacts: dto.contacts,
      deadline: optionalDatePatch(dto.deadline, 'deadline'),
      status: dto.status,
    });

    this.logger.log(`Изменена вакансия «${job.title}» (${job.id})`);

    return toDto(job, today());
  }

  /**
   * Удаление **без единой проверки** — сознательное исключение из правила,
   * действующего с сессии 0007 («запись со следами не удаляется»). Следов
   * у вакансии не бывает: на неё никто не ссылается, откликов система
   * не принимает, а закрытое место чаще всего просто ошибка оператора или
   * объявление годичной давности. Тот же разбор, что с удалением лида (0027);
   * бережное «выключить, а не стереть» доступно статусом `INACTIVE`.
   */
  async remove(id: string): Promise<JobDeletedDto> {
    const job = await this.require(id);

    await this.repository.delete(id);
    this.logger.log(`Удалена вакансия «${job.title}» (${id})`);

    return { id: job.id, title: job.title };
  }

  /**
   * Вакансии в кабинете студента (ТЗ 5.18 + решение пользователя, сессия 0039).
   *
   * Отбор «актуальные» задан **здесь**, а не параметром запроса: `open: true`
   * приходит не из `query`, и подделать его нечем. Снятая или просроченная
   * вакансия студенту не видна ни при каких аргументах — это и есть разница
   * между «фильтром по умолчанию» и правилом.
   */
  async findOpen(query: MeJobQueryDto): Promise<Paginated<MeJobDto>> {
    const { rows, total } = await this.repository.findMany({
      search: query.search,
      open: true,
      on: today(),
      sort: query.sort,
      order: query.order,
      skip: query.skip,
      take: query.take,
    });

    return Paginated.from(rows.map(toMeDto), total, query);
  }

  private async require(id: string): Promise<JobRow> {
    const job = await this.repository.findById(id);
    if (!job) {
      throw new NotFoundException('Вакансия не найдена');
    }

    return job;
  }
}

/**
 * Полночь сегодняшнего дня по UTC — с ней сверяется срок. Колонка `deadline`
 * объявлена `@db.Date`, и сравнивать её с текущим временем значило бы объявлять
 * вакансию «до 30 ноября» просроченной тридцатого в 00:01. Часовой пояс центра
 * (UTC+5) не учитывается: календарь проекта живёт в UTC (0021, 0023, 0026, 0027),
 * а единственное исключение — день рождения, который человек замечает лично (0037).
 */
const today = (): Date => {
  const now = new Date();

  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
};

/** Пустая строка снимает срок, отсутствие поля — оставляет как есть. */
const optionalDate = (value: string | undefined, field: string): Date | null =>
  value === undefined || value === '' ? null : parseIsoDate(value, field);

const optionalDatePatch = (value: string | undefined, field: string): Date | null | undefined =>
  value === undefined ? undefined : optionalDate(value, field);

const toDto = (row: JobRow, on: Date): JobDto => ({
  id: row.id,
  title: row.title,
  company: row.company,
  description: row.description,
  requirements: row.requirements,
  contacts: row.contacts,
  // Столбец `@db.Date`: наружу уходит календарная дата без времени.
  deadline: row.deadline === null ? null : formatIsoDate(row.deadline),
  status: row.status,
  isOpen: isJobOpen(row, on),
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

/** Форма кабинета: без `status` и `isOpen` — в нём все вакансии актуальны. */
const toMeDto = (row: JobRow): MeJobDto => ({
  id: row.id,
  title: row.title,
  company: row.company,
  description: row.description,
  requirements: row.requirements,
  contacts: row.contacts,
  deadline: row.deadline === null ? null : formatIsoDate(row.deadline),
  createdAt: row.createdAt.toISOString(),
});
