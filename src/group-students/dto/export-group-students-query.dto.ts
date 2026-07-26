import { ApiPropertyOptional } from '@nestjs/swagger';
import { GroupStudentStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

import { trimString } from '../../common';

/**
 * Выгрузка состава (ТЗ 5.5). Пагинации нет намеренно: файл, в который попала
 * одна страница из двадцати строк, не является выгрузкой состава. Доменные
 * фильтры при этом остаются — «выгрузить покинувших курс» (секция Left course
 * из ТЗ 5.5) это тот же список со `status=LEFT`.
 */
export class ExportGroupStudentsQueryDto {
  @ApiPropertyOptional({
    enum: GroupStudentStatus,
    description: 'Статус членства. Без фильтра выгружается вся история состава.',
  })
  @IsOptional()
  @IsEnum(GroupStudentStatus)
  status?: GroupStudentStatus;

  @ApiPropertyOptional({ description: 'Поиск по имени, фамилии и телефону студента' })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(200)
  search?: string;
}
