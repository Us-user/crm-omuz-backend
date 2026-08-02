import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';

import { Paginated } from '../common';
import type {
  CreateTemplateDto,
  TemplateDeletedDto,
  TemplateDto,
  TemplateQueryDto,
  UpdateTemplateDto,
} from './dto';
import type { TemplateRow } from './mailings.repository';
import { MailingsRepository } from './mailings.repository';

/**
 * Шаблоны сообщений (ТЗ 5.19: «Шаблоны (CRUD)»).
 *
 * Справочник: шаблон ничего не отправляет, а подставляет текст в рассылку —
 * и подставляет **снимком**, поэтому его правка не переписывает уже
 * составленное. Из этого следует и единственная неочевидная черта раздела:
 * шаблон удаляется без 409 даже когда по нему составлены рассылки.
 */
@Injectable()
export class MailingTemplatesService {
  private readonly logger = new Logger(MailingTemplatesService.name);

  constructor(private readonly repository: MailingsRepository) {}

  async findAll(query: TemplateQueryDto): Promise<Paginated<TemplateDto>> {
    const { rows, total } = await this.repository.findTemplates({
      search: query.search,
      status: query.status,
      channel: query.channel,
      sort: query.sort,
      order: query.order,
      skip: query.skip,
      take: query.take,
    });

    return Paginated.from(rows.map(toTemplateDto), total, query);
  }

  async findOne(id: string): Promise<TemplateDto> {
    return toTemplateDto(await this.require(id));
  }

  async create(dto: CreateTemplateDto, accountId: string): Promise<TemplateDto> {
    await this.assertNameFree(dto.name);

    const template = await this.repository.createTemplate({
      name: dto.name,
      title: dto.title,
      body: dto.body,
      channel: dto.channel ?? null,
      status: dto.status,
      createdById: await this.employeeIdOf(accountId),
    });

    this.logger.log(`Создан шаблон сообщения ${template.name} (${template.id})`);

    return toTemplateDto(template);
  }

  async update(id: string, dto: UpdateTemplateDto): Promise<TemplateDto> {
    await this.require(id);

    if (dto.name !== undefined) {
      await this.assertNameFree(dto.name, id);
    }

    const template = await this.repository.updateTemplate(id, {
      name: dto.name,
      title: dto.title,
      body: dto.body,
      // `undefined` — колонку не трогать, `null` — снять привязку к каналу.
      channel: dto.channel,
      status: dto.status,
    });

    this.logger.log(`Изменён шаблон сообщения ${template.name} (${template.id})`);

    return toTemplateDto(template);
  }

  /**
   * Удаление. **Без 409 на использованный шаблон** — осознанно иначе, чем
   * филиал с записями (0007), курс с группами (0008) или купон, обещанный
   * лиду (0027).
   *
   * Критерий тот же, что во всех этих решениях: теряет ли что-нибудь ребёнок.
   * Там — терял: у лида исчезала бы скидка, которую ему называли. Здесь
   * рассылка хранит текст снимком, и от удаления шаблона у неё пропадает
   * только указатель на источник. Чтобы убрать шаблон из выбора, не трогая
   * историю, есть `status = INACTIVE`.
   */
  async remove(id: string): Promise<TemplateDeletedDto> {
    const template = await this.require(id);

    await this.repository.deleteTemplate(id);
    this.logger.log(`Удалён шаблон сообщения ${template.name} (${id})`);

    return { id: template.id, name: template.name };
  }

  private async require(id: string): Promise<TemplateRow> {
    const template = await this.repository.findTemplateById(id);
    if (!template) {
      throw new NotFoundException('Шаблон не найден');
    }

    return template;
  }

  private async assertNameFree(name: string, exceptId?: string): Promise<void> {
    const twin = await this.repository.findTemplateByName(name);
    if (twin && twin.id !== exceptId) {
      throw new ConflictException(`Шаблон с названием «${twin.name}» уже существует`);
    }
  }

  /**
   * Автор — сотрудник за токеном. `null`, если профиля нет: право могло быть
   * выдано аккаунту без карточки сотрудника, и отказывать из-за этого значило бы
   * ломать работу там, где авторство лишь подпись (приём 0026, 0029).
   */
  private async employeeIdOf(accountId: string): Promise<string | null> {
    const employee = await this.repository.findEmployeeByAccount(accountId);

    return employee?.id ?? null;
  }
}

export const toTemplateDto = (row: TemplateRow): TemplateDto => ({
  id: row.id,
  name: row.name,
  title: row.title,
  body: row.body,
  channel: row.channel,
  status: row.status,
  mailingsCount: row._count.mailings,
  createdBy: row.createdBy,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});
