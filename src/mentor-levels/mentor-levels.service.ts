import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';

import { emptyToNull, emptyToNullPatch, Paginated } from '../common';
import type {
  CreateMentorLevelDto,
  MentorLevelDeletedDto,
  MentorLevelDto,
  MentorLevelQueryDto,
  UpdateMentorLevelDto,
} from './dto';
import type { MentorLevelRow } from './mentor-levels.repository';
import { MentorLevelsRepository } from './mentor-levels.repository';

/**
 * Справочник уровней ментора (ТЗ 5.14: «Mentor levels — CRUD-справочник:
 * уровень + **часовая ставка**»).
 *
 * Правила модуля:
 *   - название уникально без учёта регистра (409): «Senior mentor» и «senior
 *     mentor» человек читает как одну ступень — то же решение, что у позиций
 *     (0006) и курсов (0007);
 *   - ступень, проставленная кому-то в истории, не удаляется (409): вместе
 *     с ней исчезла бы ставка, по которой уже считали зарплату (ТЗ 5.16).
 *     Внешний ключ стоит `RESTRICT` и БД такое удаление и так не пропустит,
 *     но проверка здесь нужна, чтобы наружу ушла причина, а не обезличенная
 *     ошибка связи;
 *   - для «ступень больше не используем» есть статус `INACTIVE` — он закрывает
 *     новые простановки, но прошлые месяцы не трогает.
 *
 * Ставка живёт здесь, а не копируется в историю (решение пользователя): её
 * пересматривают для всей лестницы разом, и копия у каждого месяца означала бы
 * правку N строк вместо одной.
 */
@Injectable()
export class MentorLevelsService {
  private readonly logger = new Logger(MentorLevelsService.name);

  constructor(private readonly repository: MentorLevelsRepository) {}

  async findAll(query: MentorLevelQueryDto): Promise<Paginated<MentorLevelDto>> {
    const { rows, total } = await this.repository.findMany({
      search: query.search,
      status: query.status,
      sort: query.sort,
      order: query.order,
      skip: query.skip,
      take: query.take,
    });

    return Paginated.from(rows.map(toDto), total, query);
  }

  async findOne(id: string): Promise<MentorLevelDto> {
    return toDto(await this.require(id));
  }

  async create(dto: CreateMentorLevelDto): Promise<MentorLevelDto> {
    await this.assertNameFree(dto.name);

    const level = await this.repository.create({
      name: dto.name,
      description: emptyToNull(dto.description),
      hourlyRate: dto.hourlyRate,
      status: dto.status,
    });

    this.logger.log(`Создан уровень ментора ${level.name} (${level.id})`);

    return toDto(level);
  }

  async update(id: string, dto: UpdateMentorLevelDto): Promise<MentorLevelDto> {
    await this.require(id);

    if (dto.name !== undefined) {
      await this.assertNameFree(dto.name, id);
    }

    const level = await this.repository.update(id, {
      name: dto.name,
      description: emptyToNullPatch(dto.description),
      hourlyRate: dto.hourlyRate,
      status: dto.status,
    });

    this.logger.log(`Изменён уровень ментора ${level.name} (${level.id})`);

    return toDto(level);
  }

  async remove(id: string): Promise<MentorLevelDeletedDto> {
    const level = await this.require(id);

    if (level._count.history > 0) {
      throw new ConflictException(
        `Уровень проставлен сотрудникам (месяцев: ${String(level._count.history)}) — ` +
          'по нему считается зарплата (ТЗ 5.16). Переведите его в статус «INACTIVE» ' +
          'вместо удаления: новым месяцам он больше не проставится, а прошлые сохранят ставку',
      );
    }

    await this.repository.delete(id);
    this.logger.log(`Удалён уровень ментора ${level.name} (${id})`);

    return { id: level.id, name: level.name };
  }

  private async require(id: string): Promise<MentorLevelRow> {
    const level = await this.repository.findById(id);
    if (!level) {
      throw new NotFoundException('Уровень ментора не найден');
    }

    return level;
  }

  private async assertNameFree(name: string, exceptId?: string): Promise<void> {
    const twin = await this.repository.findByName(name);
    if (twin && twin.id !== exceptId) {
      throw new ConflictException(`Уровень ментора «${twin.name}» уже существует`);
    }
  }
}

const toDto = (row: MentorLevelRow): MentorLevelDto => ({
  id: row.id,
  name: row.name,
  description: row.description,
  // `Prisma.Decimal` → число через `Number()`, а не `toNumber()`: так же
  // корректно, но не падает, если в слое данных лежит обычное число (0007).
  hourlyRate: Number(row.hourlyRate),
  status: row.status,
  historyCount: row._count.history,
  createdAt: row.createdAt.toISOString(),
});
