import { ApiPropertyOptional } from '@nestjs/swagger';
import { AccountStatus, AccountType } from '@prisma/client';
import { IsEnum, IsOptional } from 'class-validator';

import { PaginationQueryDto } from '../../common';

/** Поля сортировки списка аккаунтов. */
export enum AdminUserSortField {
  CreatedAt = 'createdAt',
  Phone = 'phone',
  LastLoginAt = 'lastLoginAt',
}

/**
 * Список аккаунтов для `Administration → Users` (ТЗ 5.15: «все аккаунты
 * (Type/Roles/Phone)»). Поиск — по телефону, email и имени профиля.
 */
export class AdminUserQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: AccountType, description: 'Фильтр по типу аккаунта' })
  @IsOptional()
  @IsEnum(AccountType)
  type?: AccountType;

  @ApiPropertyOptional({ enum: AccountStatus, description: 'Фильтр по статусу аккаунта' })
  @IsOptional()
  @IsEnum(AccountStatus)
  status?: AccountStatus;

  @ApiPropertyOptional({ enum: AdminUserSortField, default: AdminUserSortField.CreatedAt })
  @IsOptional()
  @IsEnum(AdminUserSortField)
  override sort: AdminUserSortField = AdminUserSortField.CreatedAt;
}
