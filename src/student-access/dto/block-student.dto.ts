import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

/**
 * Блокировка и разблокировка студента (ТЗ 5.3: «Block — блок входа, обратимо, ≠ Delete»).
 *
 * Обратимость выражена флагом в теле, а не вторым маршрутом: ТЗ перечисляет
 * ровно один адрес `POST /students/{id}/block`, а `DELETE .../block` читался бы
 * как «удалить блокировку» рядом с `DELETE /students/{id}`, который удаляет
 * человека.
 */
export class BlockStudentDto {
  @ApiProperty({
    example: true,
    description: '`true` — закрыть вход, `false` — вернуть доступ.',
  })
  @IsBoolean()
  blocked!: boolean;
}
