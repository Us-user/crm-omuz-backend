import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsUUID } from 'class-validator';

/**
 * Верхняя граница одного зачисления. Группы набирают десятками (`capacity`
 * ограничена сотней), и просьба зачислить больше — это уже не набор группы,
 * а импорт: он придёт отдельным маршрутом со своим разбором файла.
 */
export const MAX_STUDENTS_PER_REQUEST = 100;

/**
 * Зачисление студентов в группу (ТЗ 5.5: «состав студентов»).
 *
 * Список, а не один `studentId`: группу набирают пачкой из общего списка
 * студентов, и пооднократное зачисление означало бы N запросов там, где
 * оператор сделал одно действие. Зачисление идёт одной транзакцией — группа
 * с половиной набора хуже, чем отказ целиком (ТЗ 7).
 */
export class AddGroupStudentsDto {
  @ApiProperty({
    type: [String],
    format: 'uuid',
    minItems: 1,
    maxItems: MAX_STUDENTS_PER_REQUEST,
    description:
      'Профили студентов (`Student.id`), а не аккаунты: студент может учиться ' +
      'без логина (ТЗ 5.3 — «аккаунт опционален, Invite»).',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_STUDENTS_PER_REQUEST)
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  studentIds!: string[];
}
