import { ApiPropertyOptional } from '@nestjs/swagger';
import { GroupMentorRole, GroupStatus } from '@prisma/client';
import { IsEnum, IsOptional } from 'class-validator';

import { PaginationQueryDto, SortOrder } from '../../common';

/**
 * Поля сортировки своих групп. Перечисление, а не свободная строка
 * из `PaginationQueryDto`: иначе значение дошло бы до `orderBy` Prisma
 * и вернулось ошибкой БД (500) на первом же неизвестном поле.
 */
export enum MentorGroupSortField {
  /** Когда сотрудника назначили: свежее назначение почти всегда и есть текущее. */
  AssignedAt = 'assignedAt',
  /** По названию группы — когда групп несколько и их ищут глазами. */
  Name = 'name',
}

/** Свои группы (ТЗ 3.5, 5.4 — раздел «Groups»). */
export class MentorGroupQueryDto extends PaginationQueryDto {
  // По умолчанию — свежие назначения сверху: наверху нужен текущий набор,
  // а завершённые группы это история, которая читается ниже.
  @ApiPropertyOptional({ enum: MentorGroupSortField, default: MentorGroupSortField.AssignedAt })
  @IsOptional()
  @IsEnum(MentorGroupSortField)
  override sort: MentorGroupSortField = MentorGroupSortField.AssignedAt;

  @ApiPropertyOptional({ enum: SortOrder, default: SortOrder.Desc })
  @IsOptional()
  @IsEnum(SortOrder)
  override order: SortOrder = SortOrder.Desc;

  @ApiPropertyOptional({
    enum: GroupMentorRole,
    description: '`TEACHING` — веду занятия, `SUPPORT` — помогаю на занятиях (ТЗ 5.5)',
  })
  @IsOptional()
  @IsEnum(GroupMentorRole)
  role?: GroupMentorRole;

  @ApiPropertyOptional({
    enum: GroupStatus,
    description: 'Только группы с этим статусом. `ACTIVE` — «что я веду сейчас».',
  })
  @IsOptional()
  @IsEnum(GroupStatus)
  status?: GroupStatus;
}
