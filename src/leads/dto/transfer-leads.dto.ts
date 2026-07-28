import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsUUID } from 'class-validator';

/**
 * Верхняя граница одного перевода. Пачку собирают галочками на экране списка,
 * а не файлом: просьба перевести больше означает выгрузку всей воронки разом,
 * и каждая строка в ней заводит профиль студента — операция дороже зачисления
 * (`MAX_STUDENTS_PER_REQUEST` = 100 по той же логике, 0012).
 */
export const MAX_LEADS_PER_TRANSFER = 100;

/**
 * Перевод лидов в студенты (ТЗ 5.7: «Transfer в студенты (bulk/по строке)»).
 *
 * Список, а не один `leadId`: ТЗ прямо просит оба режима, и «по строке» —
 * это тот же маршрут с одним элементом. Второй маршрут на один лид отвечал бы
 * на тот же вопрос другими словами и разошёлся бы с первым при первой правке
 * правил (то же решение, что с зачислением пачкой, 0012).
 *
 * Пачка применяется целиком или не применяется вовсе: любая непереводимая
 * строка — 422 с отчётом, и в БД при этом не записано ничего.
 */
export class TransferLeadsDto {
  @ApiProperty({
    type: [String],
    format: 'uuid',
    minItems: 1,
    maxItems: MAX_LEADS_PER_TRANSFER,
    description:
      'Обращения (`Lead.id`), которые нужно перевести в студенты. Для режима ' +
      '«по строке» — список из одного элемента.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_LEADS_PER_TRANSFER)
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  leadIds!: string[];
}
