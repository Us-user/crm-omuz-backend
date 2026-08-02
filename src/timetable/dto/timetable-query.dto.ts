import { ApiPropertyOptional } from '@nestjs/swagger';
import { GroupFormat } from '@prisma/client';
import { IsEnum, IsOptional, IsUUID, Matches } from 'class-validator';

import { ISO_DATE_PATTERN } from '../../common';
import { TimetableView } from '../timetable';

/**
 * Общее расписание центра (ТЗ 5.10: `GET /timetable?view=day|week|month&date=…`).
 *
 * Пагинации нет намеренно — то же исключение из ТЗ 3.5, что у каталога прав
 * (0006), карточки недели журнала (0018) и статистики оттока (0025): неделя,
 * обрезанная посередине, календарём не является, а собирать сетку из страниц
 * пришлось бы фронту. Размер ответа при этом ограничен не потолком строк,
 * а самим окном: месяц — не больше тридцати одного дня.
 *
 * Фильтры перечня ТЗ не имеют, но ТЗ 3.3 делает разрез по филиалу сквозным,
 * а ТЗ 3.5 прямо разрешает доменные фильтры query-параметрами.
 */
export class TimetableQueryDto {
  @ApiPropertyOptional({
    enum: TimetableView,
    default: TimetableView.Week,
    description:
      'Вид календаря. `day` — одна дата, `week` — неделя с понедельника по воскресенье, ' +
      '`month` — календарный месяц целиком.',
  })
  @IsOptional()
  @IsEnum(TimetableView)
  view: TimetableView = TimetableView.Week;

  @ApiPropertyOptional({
    example: '2026-09-15',
    description:
      'Любая дата внутри нужного окна, `YYYY-MM-DD`. По умолчанию — сегодня (UTC). ' +
      'Окно строится вокруг неё: для `week` это её неделя, для `month` — её месяц.',
  })
  @IsOptional()
  @Matches(ISO_DATE_PATTERN, { message: 'date: ожидается дата в формате YYYY-MM-DD' })
  date?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Занятия одной группы.' })
  @IsOptional()
  @IsUUID()
  groupId?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Занятия всех групп курса.' })
  @IsOptional()
  @IsUUID()
  courseId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Филиал **группы** (ТЗ 3.3), а не филиал аудитории.',
  })
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Занятия в одной аудитории (ТЗ 5.10).' })
  @IsOptional()
  @IsUUID()
  roomId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Ведущий занятия — тот, кто проставлен **на слоте**, а не весь состав менторов ' +
      'группы: календарь показывает ту же колонку, по которой фильтрует. Занятия ' +
      'без назначенного ведущего под этот фильтр не попадают.',
  })
  @IsOptional()
  @IsUUID()
  mentorId?: string;

  @ApiPropertyOptional({ enum: GroupFormat, description: 'Формат группы: онлайн или очно.' })
  @IsOptional()
  @IsEnum(GroupFormat)
  format?: GroupFormat;
}
