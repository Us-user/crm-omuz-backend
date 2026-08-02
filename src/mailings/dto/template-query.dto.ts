import { ApiPropertyOptional } from '@nestjs/swagger';
import { DirectoryStatus, MessageChannel } from '@prisma/client';
import { IsEnum, IsOptional } from 'class-validator';

import { PaginationQueryDto, SortOrder } from '../../common';

/** Поля, по которым разрешено сортировать список шаблонов. */
export enum TemplateSortField {
  Name = 'name',
  Title = 'title',
  CreatedAt = 'createdAt',
}

/**
 * Список шаблонов (ТЗ 5.19). `sort` сужен до перечисления, как во всех списках
 * проекта: свободная строка из базового DTO попала бы в `orderBy` Prisma
 * и вернулась бы ошибкой БД.
 */
export class TemplateQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: TemplateSortField, default: TemplateSortField.Name })
  @IsOptional()
  @IsEnum(TemplateSortField)
  override sort: TemplateSortField = TemplateSortField.Name;

  // Справочник читают по алфавиту — как филиалы, позиции и купоны.
  @ApiPropertyOptional({ enum: SortOrder, default: SortOrder.Asc })
  @IsOptional()
  @IsEnum(SortOrder)
  override order: SortOrder = SortOrder.Asc;

  @ApiPropertyOptional({ enum: DirectoryStatus, description: 'Active/Inactive.' })
  @IsOptional()
  @IsEnum(DirectoryStatus)
  status?: DirectoryStatus;

  @ApiPropertyOptional({
    enum: MessageChannel,
    description:
      'Шаблоны, годные для этого канала. Шаблоны **без канала** в выборку тоже ' +
      'попадают: текст, не привязанный к каналу, годится любому — то же правило, ' +
      'что у купона с пустым набором курсов (0027).',
  })
  @IsOptional()
  @IsEnum(MessageChannel)
  channel?: MessageChannel;
}
