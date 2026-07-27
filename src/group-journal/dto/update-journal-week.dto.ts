import { ApiPropertyOptional } from '@nestjs/swagger';
import { AttendanceMark } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsUUID,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

import { ISO_DATE_PATTERN } from '../../common';
import { MAX_HOMEWORK_SCORE } from '../journal-scoring';
import { JournalDayInputDto, MAX_DAYS_PER_WEEK } from './create-journal-week.dto';

/** Потолки одного запроса: 100 студентов × 7 дней плюс запас. */
export const MAX_ENTRIES_PER_REQUEST = 1000;
export const MAX_RESULTS_PER_REQUEST = 200;

/** Потолок ручных слагаемых — защита от лишнего нуля, а не правило ТЗ. */
export const MAX_BONUS = 100;
export const MAX_EXAM = 100;

/**
 * Правка одной клетки журнала (ТЗ 5.8: «Att + Score»).
 *
 * Не переданное поле не трогается, `null` — снимает отметку. Три состояния
 * разведены явно: без `null` поставленную по ошибке отметку нельзя было бы
 * убрать вообще, а без «не трогать» проставление ДЗ стирало бы посещаемость.
 */
export class JournalEntryInputDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsUUID()
  studentId!: string;

  @ApiPropertyOptional({ example: '2026-09-07', description: 'Учебный день недели' })
  @Matches(ISO_DATE_PATTERN, { message: 'date: ожидается дата в формате YYYY-MM-DD' })
  date!: string;

  @ApiPropertyOptional({
    enum: AttendanceMark,
    nullable: true,
    description: 'Посещаемость; `null` снимает отметку, отсутствие поля её не трогает.',
  })
  @IsOptional()
  @IsEnum(AttendanceMark)
  attendance?: AttendanceMark | null;

  @ApiPropertyOptional({
    minimum: 0,
    maximum: MAX_HOMEWORK_SCORE,
    nullable: true,
    description: 'Балл за домашнее задание (ТЗ 5.8: до 5); `null` — не проверено.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_HOMEWORK_SCORE)
  score?: number | null;
}

/** Ручные слагаемые недели по студенту (ТЗ 5.8: «Bonus / Exam»). */
export class WeekResultInputDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsUUID()
  studentId!: string;

  @ApiPropertyOptional({ minimum: 0, maximum: MAX_BONUS, description: 'Премия за неделю' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_BONUS)
  bonus?: number;

  @ApiPropertyOptional({
    minimum: 0,
    maximum: MAX_EXAM,
    description: 'Балл за экзамен: отдельное слагаемое, приход в этот день не считается.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_EXAM)
  exam?: number;
}

/**
 * Правка недели журнала (ТЗ 5.8).
 *
 * `days` **заменяет** набор дней целиком (как галочки прав позиции в сессии 0006
 * и «Show to group» в сессии 0009): экран сохраняет весь список, и при слиянии
 * убрать лишний день было бы нечем. `entries` и `results`, наоборот, точечные —
 * это отдельные клетки таблицы, а не список.
 */
export class UpdateJournalWeekDto {
  @ApiPropertyOptional({ example: '2026-09-07', description: 'Новое начало недели' })
  @IsOptional()
  @Matches(ISO_DATE_PATTERN, { message: 'startDate: ожидается дата в формате YYYY-MM-DD' })
  startDate?: string;

  @ApiPropertyOptional({
    type: [JournalDayInputDto],
    description:
      'Полный набор учебных дней. Убранный день уносит свои отметки: клетка ' +
      'дня, которого в неделе нет, ничего не значит.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_DAYS_PER_WEEK)
  @ValidateNested({ each: true })
  @Type(() => JournalDayInputDto)
  days?: JournalDayInputDto[];

  @ApiPropertyOptional({ type: [JournalEntryInputDto], description: 'Правки клеток журнала' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_ENTRIES_PER_REQUEST)
  @ValidateNested({ each: true })
  @Type(() => JournalEntryInputDto)
  entries?: JournalEntryInputDto[];

  @ApiPropertyOptional({ type: [WeekResultInputDto], description: 'Правки Bonus и Exam' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_RESULTS_PER_REQUEST)
  @ValidateNested({ each: true })
  @Type(() => WeekResultInputDto)
  results?: WeekResultInputDto[];
}

/**
 * «Отметить всех присутствующими» (ТЗ 5.8).
 *
 * Без `date` действие применяется ко всем дням недели, с датой — к одному:
 * на экране кнопка стоит и над столбцом дня, и над таблицей целиком.
 */
export class MarkAllPresentDto {
  @ApiPropertyOptional({
    example: '2026-09-07',
    description: 'Учебный день; без него отмечаются все дни недели.',
  })
  @IsOptional()
  @Matches(ISO_DATE_PATTERN, { message: 'date: ожидается дата в формате YYYY-MM-DD' })
  date?: string;
}
