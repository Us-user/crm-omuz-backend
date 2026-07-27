import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';

import { trimString } from '../../common';

/** Нижняя граница — та же, что у причины смены статуса (сессия 0012): «ок» ничего не объясняет. */
export const FEEDBACK_MIN_LENGTH = 3;
export const FEEDBACK_MAX_LENGTH = 2000;

/**
 * Заметка сотрудника о студенте (ТЗ 5.3: карточка — Feedback).
 *
 * Оценки в заметке нет намеренно: успеваемость и рейтинг считаются по журналу
 * (ТЗ 5.8, 5.13), и вторая числовая шкала конкурировала бы с ними, отвечая
 * на тот же вопрос иначе.
 */
export class CreateFeedbackDto {
  @ApiProperty({
    example: 'Пропустил две недели по болезни, догнал программу самостоятельно.',
    minLength: FEEDBACK_MIN_LENGTH,
    maxLength: FEEDBACK_MAX_LENGTH,
  })
  @Transform(trimString)
  @IsString()
  @MinLength(FEEDBACK_MIN_LENGTH)
  @MaxLength(FEEDBACK_MAX_LENGTH)
  text!: string;
}
