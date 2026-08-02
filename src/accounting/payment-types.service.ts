import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';

import type { Paginated } from '../common';
import { emptyToNullPatch, Paginated as PaginatedResult } from '../common';
import { AccountingRepository } from './accounting.repository';
import type { PaymentTypeRow } from './accounting.repository';
import type {
  CreatePaymentTypeDto,
  PaymentTypeDeletedDto,
  PaymentTypeDto,
  PaymentTypesQueryDto,
  UpdatePaymentTypeDto,
} from './dto';

/**
 * Справочник способов оплаты (ТЗ 5.16: «тип Cash/Alif»).
 *
 * Справочник, а не перечисление в схеме (решение пользователя, сессия 0029):
 * набор способов — дело центра, и появление нового банка не должно требовать
 * миграции. Правила те же, что у остальных справочников проекта: название
 * уникально без учёта регистра (0006, 0007, 0027), использованную запись
 * не удалить (409), а «вывести из работы» — это `INACTIVE`, а не удаление.
 */
@Injectable()
export class PaymentTypesService {
  private readonly logger = new Logger(PaymentTypesService.name);

  constructor(private readonly repository: AccountingRepository) {}

  async findAll(query: PaymentTypesQueryDto): Promise<Paginated<PaymentTypeDto>> {
    const { rows, total } = await this.repository.findManyTypes({
      status: query.status,
      search: query.search,
      sort: query.sort,
      order: query.order,
      skip: query.skip,
      take: query.take,
    });

    return PaginatedResult.from(rows.map(toDto), total, query);
  }

  async findOne(id: string): Promise<PaymentTypeDto> {
    return toDto(await this.require(id));
  }

  async create(dto: CreatePaymentTypeDto): Promise<PaymentTypeDto> {
    await this.assertNameFree(dto.name);

    const type = await this.repository.createType({
      name: dto.name,
      description: dto.description === undefined ? null : emptyToNullPatch(dto.description),
      status: dto.status,
    });

    this.logger.log(`Заведён способ оплаты ${type.name} (${type.id})`);

    return toDto(type);
  }

  async update(id: string, dto: UpdatePaymentTypeDto): Promise<PaymentTypeDto> {
    const existing = await this.require(id);

    // Тёзку ищем только при смене названия — и «переименование в себя»
    // конфликтом не считается (правило сессий 0006–0007).
    if (dto.name !== undefined && dto.name.toLowerCase() !== existing.name.toLowerCase()) {
      await this.assertNameFree(dto.name);
    }

    const type = await this.repository.updateType(id, {
      name: dto.name,
      description: emptyToNullPatch(dto.description),
      status: dto.status,
    });

    this.logger.log(`Изменён способ оплаты ${type.name} (${id})`);

    return toDto(type);
  }

  /**
   * Способ, которым уже платили, не удаляется (409). Внешний ключ стоит
   * `RESTRICT` и так не пустит, но наружу должна уходить причина, а не
   * обезличенная ошибка связи — то же, что со ступенью ментора (0021)
   * и курсом в купоне (0027).
   */
  async remove(id: string): Promise<PaymentTypeDeletedDto> {
    const type = await this.require(id);

    // Справочник общий для прихода и расхода (0032), поэтому держат его
    // и платежи студентов, и выплаты зарплаты — причина называет оба потока.
    const held: readonly [string, number][] = [
      ['платежи студентов', type._count.transactions],
      ['выплаты зарплаты', type._count.salaryTransactions],
    ];
    const reasons = held.filter(([, count]) => count > 0);

    if (reasons.length > 0) {
      throw new ConflictException(
        `Этим способом уже платили: ${reasons
          .map(([label, count]) => `${label} (${String(count)})`)
          .join(', ')} — переведите его в статус «INACTIVE» вместо удаления`,
      );
    }

    await this.repository.deleteType(id);
    this.logger.log(`Удалён способ оплаты ${type.name} (${id})`);

    return { id, name: type.name };
  }

  private async require(id: string): Promise<PaymentTypeRow> {
    const type = await this.repository.findTypeById(id);
    if (!type) {
      throw new NotFoundException('Способ оплаты не найден');
    }

    return type;
  }

  private async assertNameFree(name: string): Promise<void> {
    const twin = await this.repository.findTypeByName(name);
    if (twin) {
      throw new ConflictException(`Способ оплаты «${twin.name}» уже заведён`);
    }
  }
}

const toDto = (row: PaymentTypeRow): PaymentTypeDto => ({
  id: row.id,
  name: row.name,
  description: row.description,
  status: row.status,
  transactionsCount: row._count.transactions,
  salaryTransactionsCount: row._count.salaryTransactions,
  createdAt: row.createdAt.toISOString(),
});
