import { ApiProperty } from '@nestjs/swagger';
import { GroupStudentStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsEnum,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

import { trimString } from '../../common';
import { MAX_STUDENTS_PER_REQUEST } from './add-group-students.dto';

/** Причина короче трёх символов («ок», «-») ничего не объясняет читающему её потом. */
export const MIN_STATUS_REASON_LENGTH = 3;
export const MAX_STATUS_REASON_LENGTH = 500;

/**
 * Массовая смена статуса участия (ТЗ 5.5: «массовые Change status
 * (с обязательной причиной = Reason)»).
 *
 * Меняется статус **членства в группе**, а не `Student.status` (ТЗ 5.3):
 * студент может учиться параллельно на другом курсе, и уход из этой группы
 * не делает его неактивным в центре (решение сессии 0012).
 */
export class ChangeGroupStudentsStatusDto {
  @ApiProperty({
    type: [String],
    format: 'uuid',
    minItems: 1,
    maxItems: MAX_STUDENTS_PER_REQUEST,
    description: 'Студенты из состава этой группы. Посторонний в списке — 422.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_STUDENTS_PER_REQUEST)
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  studentIds!: string[];

  @ApiProperty({
    enum: GroupStudentStatus,
    description:
      'Новый статус членства. `LEFT` — покинул курс (ТЗ 5.12), `FINISHED` — прошёл ' +
      'его до конца, `ACTIVE` — возвращён в обучение. `TRANSFERRED` здесь недоступен: ' +
      'перевод ставится маршрутом `/transfer`, который заодно заводит членство в новой группе.',
  })
  @IsEnum(GroupStudentStatus)
  status!: GroupStudentStatus;

  @ApiProperty({
    example: 'Переехал в другой город',
    minLength: MIN_STATUS_REASON_LENGTH,
    maxLength: MAX_STATUS_REASON_LENGTH,
    description:
      'Обязательна по ТЗ 5.5 при любой смене статуса, включая возврат в обучение: ' +
      'запись «почему студент снова активен» нужна ровно так же, как «почему ушёл».',
  })
  @Transform(trimString)
  @IsString()
  @MinLength(MIN_STATUS_REASON_LENGTH)
  @MaxLength(MAX_STATUS_REASON_LENGTH)
  reason!: string;
}
