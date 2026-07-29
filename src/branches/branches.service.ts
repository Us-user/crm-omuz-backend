import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';

import { emptyToNull, emptyToNullPatch, Paginated } from '../common';
import { PhoneService } from '../phone';
import type { BranchRow } from './branches.repository';
import { BranchesRepository } from './branches.repository';
import type {
  BranchDeletedDto,
  BranchDto,
  BranchQueryDto,
  CreateBranchDto,
  UpdateBranchDto,
} from './dto';

/**
 * Филиалы (ТЗ 5.17). Мультифилиальность сквозная (ТЗ 3.3): на филиал ссылаются
 * аудитории, студенты и сотрудники, а позже — группы.
 *
 * Отсюда единственное нетривиальное правило модуля: **филиал с привязанными
 * записями не удаляется**. Внешние ключи стоят `RESTRICT`, поэтому БД такое
 * удаление и так не пропустит, но сервис проверяет заранее — иначе наружу
 * ушла бы обезличенная ошибка внешнего ключа вместо понятной причины.
 */
@Injectable()
export class BranchesService {
  private readonly logger = new Logger(BranchesService.name);

  constructor(
    private readonly repository: BranchesRepository,
    private readonly phones: PhoneService,
  ) {}

  async findAll(query: BranchQueryDto): Promise<Paginated<BranchDto>> {
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

  async findOne(id: string): Promise<BranchDto> {
    return toDto(await this.require(id));
  }

  async create(dto: CreateBranchDto): Promise<BranchDto> {
    await this.assertNameFree(dto.name);

    const branch = await this.repository.create({
      name: dto.name,
      city: dto.city,
      district: emptyToNull(dto.district),
      address: dto.address,
      phone: this.phones.normalizeOptional(dto.phone, 'phone') ?? null,
      description: emptyToNull(dto.description),
      status: dto.status,
    });

    this.logger.log(`Создан филиал ${branch.name} (${branch.id})`);

    return toDto(branch);
  }

  async update(id: string, dto: UpdateBranchDto): Promise<BranchDto> {
    await this.require(id);

    if (dto.name !== undefined) {
      await this.assertNameFree(dto.name, id);
    }

    const branch = await this.repository.update(id, {
      name: dto.name,
      city: dto.city,
      district: emptyToNullPatch(dto.district),
      address: dto.address,
      // Пустая строка стирает номер, непустая — нормализуется в E.164.
      phone:
        dto.phone === undefined
          ? undefined
          : (this.phones.normalizeOptional(dto.phone, 'phone') ?? null),
      description: emptyToNullPatch(dto.description),
      status: dto.status,
    });

    this.logger.log(`Изменён филиал ${branch.name} (${branch.id})`);

    return toDto(branch);
  }

  async remove(id: string): Promise<BranchDeletedDto> {
    const branch = await this.require(id);
    this.assertEmpty(branch);

    await this.repository.delete(id);
    this.logger.log(`Удалён филиал ${branch.name} (${id})`);

    return { id: branch.id, name: branch.name };
  }

  private async require(id: string): Promise<BranchRow> {
    const branch = await this.repository.findById(id);
    if (!branch) {
      throw new NotFoundException('Филиал не найден');
    }

    return branch;
  }

  private async assertNameFree(name: string, exceptId?: string): Promise<void> {
    const twin = await this.repository.findByName(name);
    if (twin && twin.id !== exceptId) {
      throw new ConflictException(`Филиал с названием «${twin.name}» уже существует`);
    }
  }

  /**
   * Филиал удаляется только пустым. Причина не в целостности (её стережёт
   * `RESTRICT`), а в данных: снести филиал, за которым числятся люди, — значит
   * потерять сведения о том, где они учились и работали.
   */
  private assertEmpty(branch: BranchRow): void {
    const attached = [
      { count: branch._count.rooms, label: 'аудитории' },
      { count: branch._count.groups, label: 'группы' },
      { count: branch._count.students, label: 'студенты' },
      { count: branch._count.employees, label: 'сотрудники' },
      { count: branch._count.leads, label: 'лиды' },
      // Расход (0030) — не «люди», но довод тот же: из отчёта о деньгах молча
      // пропало бы, куда они уходили.
      { count: branch._count.expenses, label: 'расходы' },
    ].filter((item) => item.count > 0);

    if (attached.length === 0) return;

    const listed = attached.map(({ count, label }) => `${label} (${String(count)})`).join(', ');
    throw new ConflictException(
      `К филиалу привязаны ${listed} — перенесите их в другой филиал перед удалением`,
    );
  }
}

const toDto = (row: BranchRow): BranchDto => ({
  id: row.id,
  name: row.name,
  city: row.city,
  district: row.district,
  address: row.address,
  phone: row.phone,
  description: row.description,
  status: row.status,
  roomsCount: row._count.rooms,
  groupsCount: row._count.groups,
  studentsCount: row._count.students,
  employeesCount: row._count.employees,
  createdAt: row.createdAt.toISOString(),
});
