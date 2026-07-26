import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';

import { BusinessRuleException, emptyToNull, emptyToNullPatch, Paginated } from '../common';
import type { CreateRoomDto, RoomDeletedDto, RoomDto, RoomQueryDto, UpdateRoomDto } from './dto';
import type { RoomRow } from './rooms.repository';
import { RoomsRepository } from './rooms.repository';

/**
 * Аудитории (ТЗ 5.10). Комната физически принадлежит филиалу, поэтому
 * `branchId` обязателен, а название уникально **внутри филиала**: аудитория
 * «101» вполне может быть в каждом из них.
 */
@Injectable()
export class RoomsService {
  private readonly logger = new Logger(RoomsService.name);

  constructor(private readonly repository: RoomsRepository) {}

  async findAll(query: RoomQueryDto): Promise<Paginated<RoomDto>> {
    const { rows, total } = await this.repository.findMany({
      search: query.search,
      branchId: query.branchId,
      status: query.status,
      sort: query.sort,
      order: query.order,
      skip: query.skip,
      take: query.take,
    });

    return Paginated.from(rows.map(toDto), total, query);
  }

  async findOne(id: string): Promise<RoomDto> {
    return toDto(await this.require(id));
  }

  async create(dto: CreateRoomDto): Promise<RoomDto> {
    await this.assertBranchExists(dto.branchId);
    await this.assertNameFree(dto.branchId, dto.name);

    const room = await this.repository.create({
      branchId: dto.branchId,
      name: dto.name,
      capacity: dto.capacity ?? null,
      floor: dto.floor ?? null,
      description: emptyToNull(dto.description),
      status: dto.status,
    });

    this.logger.log(`Создана аудитория ${room.name} в филиале ${room.branch.name} (${room.id})`);

    return toDto(room);
  }

  async update(id: string, dto: UpdateRoomDto): Promise<RoomDto> {
    const existing = await this.require(id);

    // Филиал берётся из запроса, если его меняют, иначе — текущий: тёзку нужно
    // искать в том филиале, где комната окажется после правки, а не в прежнем.
    const branchId = dto.branchId ?? existing.branch.id;
    if (dto.branchId !== undefined && dto.branchId !== existing.branch.id) {
      await this.assertBranchExists(dto.branchId);
    }

    if (dto.name !== undefined || branchId !== existing.branch.id) {
      await this.assertNameFree(branchId, dto.name ?? existing.name, id);
    }

    const room = await this.repository.update(id, {
      branchId: dto.branchId,
      name: dto.name,
      capacity: dto.capacity,
      floor: dto.floor,
      description: emptyToNullPatch(dto.description),
      status: dto.status,
    });

    this.logger.log(`Изменена аудитория ${room.name} (${room.id})`);

    return toDto(room);
  }

  /**
   * Аудитория удаляется только свободной. Внешний ключ расписания стоит
   * `RESTRICT`, поэтому БД такое удаление и так не пропустит, но сервис
   * проверяет заранее — иначе наружу ушла бы обезличенная ошибка внешнего
   * ключа вместо причины (так же устроено удаление филиала).
   */
  async remove(id: string): Promise<RoomDeletedDto> {
    const room = await this.require(id);

    const slots = await this.repository.countScheduleSlots(id);
    if (slots > 0) {
      throw new ConflictException(
        `В аудитории стоят занятия (${String(slots)}) — измените расписание групп перед удалением`,
      );
    }

    await this.repository.delete(id);
    this.logger.log(`Удалена аудитория ${room.name} (${id})`);

    return { id: room.id, name: room.name };
  }

  private async require(id: string): Promise<RoomRow> {
    const room = await this.repository.findById(id);
    if (!room) {
      throw new NotFoundException('Аудитория не найдена');
    }

    return room;
  }

  /**
   * Филиал из тела запроса — 422, а не 404: ресурс из пути найден (или создаётся),
   * не найдено то, что пришло в теле. Тот же выбор сделан в назначении ролей
   * (`Administration → Users`, сессия 0006).
   */
  private async assertBranchExists(branchId: string): Promise<void> {
    const branch = await this.repository.findBranch(branchId);
    if (!branch) {
      throw new BusinessRuleException('Филиал не найден', { branchId });
    }
  }

  private async assertNameFree(branchId: string, name: string, exceptId?: string): Promise<void> {
    const twin = await this.repository.findByName(branchId, name);
    if (twin && twin.id !== exceptId) {
      throw new ConflictException(`Аудитория «${twin.name}» в этом филиале уже есть`);
    }
  }
}

const toDto = (row: RoomRow): RoomDto => ({
  id: row.id,
  name: row.name,
  branch: row.branch,
  capacity: row.capacity,
  floor: row.floor,
  description: row.description,
  status: row.status,
  createdAt: row.createdAt.toISOString(),
});
