import { randomUUID } from 'node:crypto';

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { MailingAudience, MessageChannel } from '@prisma/client';
import { NotificationStatus } from '@prisma/client';

import { BusinessRuleException, Paginated } from '../common';
import type {
  CreateMailingDto,
  MailingDeletedDto,
  MailingDto,
  MailingQueryDto,
  MailingSendResultDto,
  NotificationDto,
  NotificationQueryDto,
  UpdateMailingDto,
} from './dto';
import { MailingDispatcher } from './mailing-dispatcher';
import type { DeliveryCounts } from './mailings';
import {
  addressFor,
  audienceNeedsGroup,
  countDeliveries,
  EMPTY_DELIVERY_COUNTS,
  MAX_MAILING_RECIPIENTS,
  MailingStatus,
  mailingStatusOf,
  recipientNameOf,
  recipientTypeOf,
} from './mailings';
import type {
  MailingRow,
  NotificationRow,
  NotificationSeed,
  RecipientRow,
} from './mailings.repository';
import { MailingsRepository } from './mailings.repository';

/** Пометка в строке доставки, когда адреса канала у получателя нет. */
export const NO_ADDRESS_REASON = 'Адрес канала у получателя не указан';

/**
 * Рассылки (ТЗ 5.19).
 *
 * Рассылка живёт двумя состояниями: черновик правится, отправленная — нет.
 * Отправка **вычисляет аудиторию в этот момент** и застывает строками
 * `Notification` по одной на человека: только так система отвечает на вопрос
 * «дошло ли до этого студента» и умеет повторить упавшие, не рассылая заново
 * всем (решение пользователя).
 */
@Injectable()
export class MailingsService {
  private readonly logger = new Logger(MailingsService.name);

  constructor(
    private readonly repository: MailingsRepository,
    private readonly dispatcher: MailingDispatcher,
  ) {}

  async findAll(query: MailingQueryDto): Promise<Paginated<MailingDto>> {
    return this.list(query, query.sent);
  }

  /**
   * История (ТЗ 5.19: `GET /mailings/history`). Отличается от списка ровно
   * одним: здесь только **отправленные**, и порядок по умолчанию — по дате
   * отправки. Тот же маршрут с `?sent=true` дал бы то же самое, но ТЗ называет
   * историю отдельным экраном, и передавать фильтр за него значило бы
   * требовать от фронта знать правило, а не адрес.
   */
  async findHistory(query: MailingQueryDto): Promise<Paginated<MailingDto>> {
    return this.list(query, true);
  }

  async findOne(id: string): Promise<MailingDto> {
    const mailing = await this.require(id);
    const counts = await this.countsOf([mailing.id]);

    return toMailingDto(mailing, counts.get(mailing.id) ?? EMPTY_DELIVERY_COUNTS);
  }

  async create(dto: CreateMailingDto, accountId: string): Promise<MailingDto> {
    const { title, body, templateId } = await this.resolveText(dto.title, dto.body, dto.templateId);
    const groupId = await this.resolveGroup(dto.audience, dto.groupId);

    const mailing = await this.repository.createMailing({
      title,
      body,
      channel: dto.channel,
      audience: dto.audience,
      groupId,
      templateId,
      createdById: await this.employeeIdOf(accountId),
    });

    this.logger.log(`Составлена рассылка «${mailing.title}» (${mailing.id})`);

    return toMailingDto(mailing, EMPTY_DELIVERY_COUNTS);
  }

  /**
   * Правка **черновика**. Отправленная рассылка — строка истории: менять её
   * текст задним числом значило бы расходиться с тем, что люди уже прочитали.
   */
  async update(id: string, dto: UpdateMailingDto): Promise<MailingDto> {
    const existing = await this.require(id);
    assertDraft(existing, 'изменить');

    // Правило «текст обязателен» проверяется по **итоговому** состоянию:
    // передать можно одно поле, и сверять его с пустотой значило бы требовать
    // заново то, что уже лежит в записи (приём 0027 со сроками купона).
    const template =
      dto.templateId === undefined
        ? { title: dto.title, body: dto.body, templateId: undefined }
        : await this.resolveText(
            dto.title ?? existing.title,
            dto.body ?? existing.body,
            dto.templateId,
          );

    const audience = dto.audience ?? existing.audience;
    const groupId =
      dto.audience === undefined && dto.groupId === undefined
        ? undefined
        : await this.resolveGroup(audience, dto.groupId ?? existing.group?.id);

    const mailing = await this.repository.updateMailing(id, {
      title: template.title,
      body: template.body,
      channel: dto.channel,
      audience: dto.audience,
      groupId,
      templateId: template.templateId,
    });

    this.logger.log(`Изменена рассылка «${mailing.title}» (${mailing.id})`);

    return toMailingDto(mailing, EMPTY_DELIVERY_COUNTS);
  }

  /**
   * Удаление черновика — сверх перечня маршрутов ТЗ 5.19 (там только
   * `GET/POST /mailings`). Без него ошибочно составленная рассылка осталась бы
   * в списке навсегда.
   *
   * Отправленная не удаляется (422): это история того, что центр написал людям,
   * и стирать её значило бы отвечать «мы такого не отправляли» на письмо,
   * которое человек держит в руках. Тот же довод, что у архивного финансового
   * периода (0033) и снимка победителей месяца (0024).
   */
  async remove(id: string): Promise<MailingDeletedDto> {
    const mailing = await this.require(id);
    assertDraft(mailing, 'удалить');

    await this.repository.deleteMailing(id);
    this.logger.log(`Удалён черновик рассылки «${mailing.title}» (${id})`);

    return { id: mailing.id, title: mailing.title };
  }

  /**
   * Отправка (ТЗ 5.19: «→ Send»).
   *
   * Порядок шагов и есть содержание правила:
   * 1. рассылка ещё не отправлена (422 на повторную — иначе люди получили бы
   *    второе сообщение, и отменить это было бы нечем);
   * 2. аудитория вычисляется **сейчас**, а не в день составления черновика;
   * 3. пустая аудитория — отказ: «отправлено никому» не состояние рассылки,
   *    а незамеченная ошибка;
   * 4. строки доставки и отметка об отправке пишутся одной транзакцией;
   * 5. задачи ставятся в очередь **после** её фиксации.
   */
  async send(id: string, accountId: string): Promise<MailingSendResultDto> {
    const mailing = await this.require(id);
    assertDraft(mailing, 'отправить');

    const recipients = await this.resolveAudience(mailing.audience, mailing.group?.id ?? null);

    if (recipients.length === 0) {
      throw new BusinessRuleException('Аудитория пуста — отправлять некому', {
        audience: mailing.audience,
      });
    }

    if (recipients.length > MAX_MAILING_RECIPIENTS) {
      throw new BusinessRuleException(
        `Аудитория больше допустимого предела (${String(MAX_MAILING_RECIPIENTS)})`,
        { recipients: recipients.length, max: MAX_MAILING_RECIPIENTS },
      );
    }

    const seeds = recipients.map((recipient) =>
      seedOf(recipient, mailing.channel, mailing.audience),
    );

    const sent = await this.repository.markSent({
      mailingId: id,
      sentAt: new Date(),
      sentById: await this.employeeIdOf(accountId),
      notifications: seeds,
    });

    const queued = seeds
      .filter((seed) => seed.status === NotificationStatus.PENDING)
      .map((seed) => seed.id);

    await this.dispatcher.enqueue(queued);

    const deliveries = countSeeds(seeds);
    this.logger.log(
      `Отправлена рассылка «${sent.title}» (${id}): получателей ${String(deliveries.total)}, ` +
        `в очередь ${String(queued.length)}, без адреса ${String(deliveries.skipped)}`,
    );

    return {
      mailing: toMailingDto(sent, deliveries),
      deliveries,
      queued: queued.length,
    };
  }

  /**
   * Повтор незавершённых доставок — сверх перечня маршрутов ТЗ 5.19.
   *
   * Ровно то, ради чего доставка хранится строкой на человека: временный отказ
   * провайдера у двадцати получателей из тысячи не должен означать, что весь
   * список получит сообщение по второму разу.
   *
   * Берутся `FAILED` **и `PENDING`**. Второе не избыточность: между фиксацией
   * транзакции отправки и постановкой задач приложение может упасть, и такая
   * доставка навсегда осталась бы «в очереди», которой её никто не поручал.
   * Повторная задача безопасна — обработчик берёт только `PENDING` и после
   * первой же успешной отправки второй заход пропускает.
   *
   * `SKIPPED` не берётся: у этих людей нет адреса, и повторять нечего, пока
   * его не заполнят, — иначе повтор каждый раз заново «падал» бы на них.
   */
  async retry(id: string): Promise<MailingSendResultDto> {
    const mailing = await this.require(id);

    if (mailing.sentAt === null) {
      throw new BusinessRuleException('Рассылка ещё не отправлена — повторять нечего', {
        mailingId: id,
      });
    }

    const retryable = await this.repository.findRetryableDeliveryIds(id);
    await this.repository.resetDeliveries(retryable);
    await this.dispatcher.enqueue(retryable);

    const counts = await this.countsOf([id]);
    this.logger.log(
      `Повтор рассылки «${mailing.title}» (${id}): задач ${String(retryable.length)}`,
    );

    return {
      mailing: toMailingDto(mailing, counts.get(id) ?? EMPTY_DELIVERY_COUNTS),
      deliveries: counts.get(id) ?? EMPTY_DELIVERY_COUNTS,
      queued: retryable.length,
    };
  }

  /**
   * Доставки рассылки — «дошло ли до конкретного человека» (сверх перечня ТЗ).
   * Без этого списка строка на получателя не отвечала бы ни на один вопрос,
   * ради которого её завели.
   */
  async findRecipients(
    id: string,
    query: NotificationQueryDto,
  ): Promise<Paginated<NotificationDto>> {
    await this.require(id);

    const { rows, total } = await this.repository.findNotifications({
      mailingId: id,
      status: query.status,
      search: query.search,
      skip: query.skip,
      take: query.take,
    });

    const counts = await this.countsOf([id]);

    return Paginated.from(rows.map(toNotificationDto), total, query, {
      deliveries: counts.get(id) ?? EMPTY_DELIVERY_COUNTS,
    });
  }

  private async list(query: MailingQueryDto, sent?: boolean): Promise<Paginated<MailingDto>> {
    const { rows, total } = await this.repository.findMailings({
      search: query.search,
      audience: query.audience,
      channel: query.channel,
      groupId: query.groupId,
      sent,
      sort: query.sort,
      order: query.order,
      skip: query.skip,
      take: query.take,
    });

    const counts = await this.countsOf(rows.map((row) => row.id));

    return Paginated.from(
      rows.map((row) => toMailingDto(row, counts.get(row.id) ?? EMPTY_DELIVERY_COUNTS)),
      total,
      query,
    );
  }

  /**
   * Счётчики доставок по строкам страницы — **одним** запросом на всю страницу,
   * а не запросом на строку (приём 0007, 0035).
   */
  private async countsOf(mailingIds: string[]): Promise<Map<string, DeliveryCounts>> {
    const rows = await this.repository.countDeliveriesByMailing(mailingIds);
    const byMailing = new Map<string, { status: NotificationStatus; count: number }[]>();

    for (const row of rows) {
      const bucket = byMailing.get(row.mailingId) ?? [];
      bucket.push({ status: row.status, count: row.count });
      byMailing.set(row.mailingId, bucket);
    }

    return new Map([...byMailing].map(([id, groups]) => [id, countDeliveries(groups)]));
  }

  /** Кому уходит рассылка — правило аудитории превращается в список людей. */
  private resolveAudience(
    audience: MailingAudience,
    groupId: string | null,
  ): Promise<RecipientRow[]> {
    if (audience === 'GROUP') {
      // `groupId` заполнен: правило проверено при составлении и при правке.
      return groupId === null ? Promise.resolve([]) : this.repository.findGroupStudents(groupId);
    }

    if (audience === 'STUDENTS') return this.repository.findActiveStudents();
    if (audience === 'MENTORS') return this.repository.findMentors();
    if (audience === 'LEADS') return this.repository.findLeads();

    return this.repository.findGraduates();
  }

  /**
   * Текст рассылки. Шаблон подставляет `title`/`body` **снимком**: переданные
   * явно поля его перекрывают, а неуказанный шаблон требует обоих полей (422).
   */
  private async resolveText(
    title: string | undefined,
    body: string | undefined,
    templateId: string | undefined,
  ): Promise<{ title: string; body: string; templateId: string | null }> {
    if (templateId === undefined) {
      if (title === undefined || body === undefined) {
        throw new BusinessRuleException(
          'Без шаблона нужно указать и заголовок, и текст сообщения',
          { title: title === undefined, body: body === undefined },
        );
      }

      return { title, body, templateId: null };
    }

    const template = await this.repository.findTemplateById(templateId);
    if (!template) {
      throw new BusinessRuleException('Шаблон не найден', { templateId });
    }

    return {
      title: title ?? template.title,
      body: body ?? template.body,
      templateId,
    };
  }

  /**
   * Группа-адресат. Правило действует **в обе стороны**: у аудитории `GROUP`
   * группа обязательна, у остальных — запрещена. Второе не придирка: группа
   * у рассылки «всем студентам» выглядела бы отбором, которого не произойдёт,
   * и первый же оператор решил бы, что письмо уйдёт одной группе.
   */
  private async resolveGroup(
    audience: MailingAudience,
    groupId: string | undefined,
  ): Promise<string | null> {
    if (!audienceNeedsGroup(audience)) {
      if (groupId !== undefined && groupId !== null) {
        throw new BusinessRuleException('Группа указывается только у аудитории GROUP', {
          audience,
        });
      }

      return null;
    }

    if (groupId === undefined || groupId === null) {
      throw new BusinessRuleException('Для аудитории GROUP нужно указать группу', { audience });
    }

    const group = await this.repository.findGroup(groupId);
    if (!group) {
      throw new BusinessRuleException('Группа не найдена', { groupId });
    }

    return group.id;
  }

  private async require(id: string): Promise<MailingRow> {
    const mailing = await this.repository.findMailingById(id);
    if (!mailing) {
      throw new NotFoundException('Рассылка не найдена');
    }

    return mailing;
  }

  private async employeeIdOf(accountId: string): Promise<string | null> {
    const employee = await this.repository.findEmployeeByAccount(accountId);

    return employee?.id ?? null;
  }
}

/**
 * Строка доставки из получателя. Здесь же решается судьба человека без адреса:
 * он попадает в рассылку строкой `SKIPPED` с причиной, а не выпадает из неё.
 *
 * Молча пропустить было бы проще и хуже: рассылка на сто человек показала бы
 * шестьдесят доставок без единого объяснения, куда делись остальные сорок.
 * Пробел обязан остаться видимым — то же правило, что у `averageScore: null`
 * (0019), «месяца без записи об уровне» (0021) и «статус не выяснен» (0026).
 */
export const seedOf = (
  recipient: RecipientRow,
  channel: MessageChannel,
  audience: MailingAudience,
): NotificationSeed => {
  const type = recipientTypeOf(audience);
  const address = addressFor(channel, recipient);

  return {
    id: randomUUID(),
    channel,
    recipientType: type,
    recipientName: recipientNameOf(recipient.firstName, recipient.lastName),
    address: address ?? '',
    studentId: type === 'STUDENT' ? recipient.id : null,
    employeeId: type === 'EMPLOYEE' ? recipient.id : null,
    leadId: type === 'LEAD' ? recipient.id : null,
    status: address === null ? NotificationStatus.SKIPPED : NotificationStatus.PENDING,
    error: address === null ? NO_ADDRESS_REASON : null,
  };
};

/** Счётчики прямо из заготовок — до того, как их прочитают обратно из БД. */
const countSeeds = (seeds: readonly NotificationSeed[]): DeliveryCounts =>
  countDeliveries(seeds.map((seed) => ({ status: seed.status, count: 1 })));

/** Отправленная рассылка не правится, не удаляется и не отправляется второй раз. */
const assertDraft = (mailing: MailingRow, action: string): void => {
  if (mailing.sentAt !== null) {
    throw new BusinessRuleException(`Отправленную рассылку нельзя ${action}`, {
      mailingId: mailing.id,
      sentAt: mailing.sentAt.toISOString(),
    });
  }
};

export const toMailingDto = (row: MailingRow, deliveries: DeliveryCounts): MailingDto => ({
  id: row.id,
  title: row.title,
  body: row.body,
  channel: row.channel,
  audience: row.audience,
  group: row.group,
  template: row.template,
  status: mailingStatusOf(row.sentAt, deliveries),
  deliveries,
  sentAt: row.sentAt === null ? null : row.sentAt.toISOString(),
  sentBy: row.sentBy,
  createdBy: row.createdBy,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

export const toNotificationDto = (row: NotificationRow): NotificationDto => ({
  id: row.id,
  channel: row.channel,
  recipientType: row.recipientType,
  recipientName: row.recipientName,
  address: row.address,
  // Ровно одна из трёх ссылок заполнена — по `recipientType`; после удаления
  // профиля не заполнена ни одна, и наружу уходит `null` при живых имени и адресе.
  recipientId: row.studentId ?? row.employeeId ?? row.leadId,
  status: row.status,
  error: row.error,
  attempts: row.attempts,
  sentAt: row.sentAt === null ? null : row.sentAt.toISOString(),
  createdAt: row.createdAt.toISOString(),
});

export { MailingStatus };
