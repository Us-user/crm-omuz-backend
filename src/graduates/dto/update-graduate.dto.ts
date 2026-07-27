import { ApiPropertyOptional } from '@nestjs/swagger';
import { GraduateEmployment } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsEnum, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

import { ISO_DATE_PATTERN, trimString } from '../../common';

/** Верхняя граница поля «Work place» (ТЗ 5.11) — свободный текст, но не роман. */
export const MAX_WORK_PLACE_LENGTH = 200;

/**
 * Правка карточки выпускника (ТЗ 5.11).
 *
 * Правятся только те поля, которые система **не** выводит сама: где человек
 * работает и с какой даты он считается выпустившимся. `points` и `weeksCount`
 * сюда не входят — это снимок общего балла на момент выпуска (решение
 * пользователя, сессия 0026), и правка руками сделала бы «за что выдан
 * сертификат» ничем не подтверждённым. Серийный номер и дата выдачи ставятся
 * отдельным действием под своим правом (`POST …/certificate`).
 *
 * Пустая строка очищает поле, не переданное — не трогает (правило сессии 0007).
 */
export class UpdateGraduateDto {
  @ApiPropertyOptional({
    enum: GraduateEmployment,
    nullable: true,
    description: 'Статус трудоустройства (ТЗ 5.11). `null` снимает статус обратно в «не выяснен».',
  })
  @IsOptional()
  @IsEnum(GraduateEmployment)
  employment?: GraduateEmployment | null;

  @ApiPropertyOptional({
    example: 'ООО «Алиф Технолоджи»',
    maxLength: MAX_WORK_PLACE_LENGTH,
    description: 'Место работы (ТЗ 5.11: «Work place»). Пустая строка очищает поле.',
  })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(MAX_WORK_PLACE_LENGTH)
  workPlace?: string;

  @ApiPropertyOptional({
    example: '2026-06-30',
    description:
      'Дата выпуска. Автовыпуск ставит сюда срок окончания группы, но ошибку оператора ' +
      'в сроках нужно чем-то исправлять — поэтому дата правится, в отличие от балла.',
  })
  @IsOptional()
  @Matches(ISO_DATE_PATTERN, { message: 'graduatedAt: ожидается дата в формате YYYY-MM-DD' })
  graduatedAt?: string;
}
