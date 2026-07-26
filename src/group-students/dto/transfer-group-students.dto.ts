import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

import { trimString } from '../../common';
import { MAX_STUDENTS_PER_REQUEST } from './add-group-students.dto';
import {
  MAX_STATUS_REASON_LENGTH,
  MIN_STATUS_REASON_LENGTH,
} from './change-group-students-status.dto';

/**
 * Массовый перевод студентов в другую группу (ТЗ 5.5: «Transfer в другую группу»).
 *
 * Перевод — это две записи, а не правка одной: членство в прежней группе
 * закрывается статусом `TRANSFERRED` (с причиной и датой), а в новой заводится
 * действующее. Иначе учебная история студента переписывалась бы задним числом,
 * и «в какой группе он учился в сентябре» ответить было бы нечем.
 */
export class TransferGroupStudentsDto {
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
    format: 'uuid',
    description:
      'Группа назначения. Курс менять не запрещено — перевод между потоками ' +
      'одного курса и переход на соседний курс делаются одним действием.',
  })
  @IsUUID()
  targetGroupId!: string;

  @ApiProperty({
    example: 'Не совпадает расписание, переведён в вечерний поток',
    minLength: MIN_STATUS_REASON_LENGTH,
    maxLength: MAX_STATUS_REASON_LENGTH,
    description: 'Обязательна по ТЗ 5.5 — той же причиной закрывается прежнее членство.',
  })
  @Transform(trimString)
  @IsString()
  @MinLength(MIN_STATUS_REASON_LENGTH)
  @MaxLength(MAX_STATUS_REASON_LENGTH)
  reason!: string;
}
