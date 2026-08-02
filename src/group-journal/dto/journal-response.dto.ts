import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AttendanceMark, GroupStudentStatus, LessonType } from '@prisma/client';

/** Учебный день недели (ТЗ 5.8). */
export class JournalDayDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: '2026-09-07' })
  date!: string;

  @ApiProperty({ enum: LessonType })
  type!: LessonType;

  @ApiPropertyOptional({
    nullable: true,
    example: { id: 'uuid', firstName: 'Фаррух', lastName: 'Раҳимов' },
    description:
      'Кто фактически провёл занятие. `null` — не записали; тогда час этого дня ' +
      'не попадёт ни в чью ведомость зарплаты (ТЗ 5.16).',
  })
  mentor!: { id: string; firstName: string; lastName: string } | null;

  @ApiPropertyOptional({
    nullable: true,
    example: 90,
    description: 'Длительность занятия в минутах; `null` — длительность не записана.',
  })
  durationMinutes!: number | null;
}

/** Сотрудник, финализировавший неделю (ТЗ 5.8: «Отправить результат»). */
export class JournalPersonDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Фаррух' })
  firstName!: string;

  @ApiProperty({ example: 'Раҳимов' })
  lastName!: string;
}

/** Неделя в списке журнала: без клеток, но с итогами (ТЗ 5.8: «График + Average»). */
export class JournalWeekSummaryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  groupId!: string;

  @ApiProperty({ example: 3, description: 'Порядковый номер недели в группе' })
  weekNumber!: number;

  @ApiProperty({ example: '2026-09-07' })
  startDate!: string;

  @ApiPropertyOptional({
    nullable: true,
    example: '2026-09-11',
    description: 'Последний учебный день недели; `null` — дней нет.',
  })
  endDate!: string | null;

  @ApiProperty({ type: [JournalDayDto] })
  days!: JournalDayDto[];

  @ApiProperty({
    description: 'Финализирована ли неделя: у заблокированной отметки больше не правятся.',
  })
  submitted!: boolean;

  @ApiPropertyOptional({ nullable: true, example: '2026-09-12T17:00:00.000Z' })
  submittedAt!: string | null;

  @ApiPropertyOptional({ type: JournalPersonDto, nullable: true })
  submittedBy!: JournalPersonDto | null;

  @ApiProperty({ example: 12, description: 'Сколько студентов имеет итог за эту неделю' })
  studentsCount!: number;

  @ApiPropertyOptional({
    nullable: true,
    example: 92.5,
    description: 'Средний Sum по неделе (ТЗ 5.8: «Average»); `null` — итогов ещё нет.',
  })
  averageSum!: number | null;
}

/** Клетка журнала: отметка студента за один день. */
export class JournalEntryDto {
  @ApiProperty({ format: 'uuid' })
  dayId!: string;

  @ApiProperty({ example: '2026-09-07' })
  date!: string;

  @ApiPropertyOptional({ enum: AttendanceMark, nullable: true, description: '`null` — не отмечен' })
  attendance!: AttendanceMark | null;

  @ApiPropertyOptional({ nullable: true, example: 5, description: '`null` — ДЗ не проверено' })
  score!: number | null;
}

/** Студент в журнале недели: профиль, его клетки и итог. */
export class JournalStudentDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Нигина' })
  firstName!: string;

  @ApiProperty({ example: 'Каримова' })
  lastName!: string;

  @ApiProperty({ example: '+992901234567' })
  phone!: string;

  @ApiPropertyOptional({ nullable: true })
  photoUrl!: string | null;
}

/** Строка журнала: студент, его отметки за дни недели и разложение итога. */
export class JournalRowDto {
  @ApiProperty({ type: JournalStudentDto })
  student!: JournalStudentDto;

  @ApiPropertyOptional({
    enum: GroupStudentStatus,
    nullable: true,
    description:
      'Статус членства в группе. `null` — студента в составе больше нет, ' +
      'но его отметки за эту неделю остались: журнал не переписывается задним числом.',
  })
  membershipStatus!: GroupStudentStatus | null;

  @ApiProperty({ type: [JournalEntryDto] })
  entries!: JournalEntryDto[];

  @ApiProperty({ example: 4, description: 'Σ(приходы); на экзамене приход не считается' })
  attendanceScore!: number;

  @ApiProperty({ example: 18, description: 'Σ(ДЗ по дням)' })
  homeworkScore!: number;

  @ApiProperty({ example: 60 })
  exam!: number;

  @ApiProperty({ example: 5 })
  bonus!: number;

  @ApiProperty({ example: 87, description: 'Σ(приходы) + Σ(ДЗ) + Exam + Bonus (ТЗ 5.8)' })
  sum!: number;
}

/** Неделя журнала целиком: дни, состав и все клетки (ТЗ 5.8). */
export class JournalWeekDto extends JournalWeekSummaryDto {
  @ApiProperty({ type: [JournalRowDto] })
  rows!: JournalRowDto[];
}

/** Ответ на «отметить всех присутствующими» (ТЗ 5.8). */
export class MarkedAllPresentDto {
  @ApiProperty({ example: 24, description: 'Сколько неотмеченных клеток заполнено' })
  marked!: number;

  @ApiProperty({ type: JournalWeekDto })
  week!: JournalWeekDto;
}

/** Одно автоначисление коинов в отчёте о финализации (ТЗ 5.9). */
export class WeekCoinAwardDto {
  @ApiProperty({ format: 'uuid' })
  studentId!: string;

  @ApiProperty({ example: 'Каримова Нигина' })
  fullName!: string;

  @ApiProperty({ example: 104 })
  sum!: number;

  @ApiProperty({ example: 5 })
  coins!: number;
}

/**
 * Отчёт Директору по финализированной неделе (ТЗ 5.8: «отчёт Директору»).
 *
 * Доставка (Telegram/почта) — Фаза 11; сейчас отчёт собирается, уходит в лог
 * приложения и возвращается тому, кто нажал «Отправить результат».
 */
export class WeekSubmitReportDto {
  @ApiProperty({ format: 'uuid' })
  groupId!: string;

  @ApiProperty({ example: 'Frontend-1' })
  groupName!: string;

  @ApiProperty({ example: 3 })
  weekNumber!: number;

  @ApiProperty({ example: '2026-09-07' })
  startDate!: string;

  @ApiProperty({ example: 12, description: 'Сколько студентов получило итог' })
  studentsCount!: number;

  @ApiPropertyOptional({ nullable: true, example: 92.5 })
  averageSum!: number | null;

  @ApiProperty({ example: 34, description: 'Всего начислено коинов по неделе' })
  coinsAwarded!: number;

  @ApiProperty({ type: [WeekCoinAwardDto], description: 'Кому и сколько начислено' })
  awards!: WeekCoinAwardDto[];
}

/** Ответ на финализацию недели (ТЗ 5.8). */
export class WeekSubmittedDto {
  @ApiProperty({ type: JournalWeekDto })
  week!: JournalWeekDto;

  @ApiProperty({ type: WeekSubmitReportDto })
  report!: WeekSubmitReportDto;
}

/** Ответ на удаление недели — чтобы интерфейс мог назвать убранное. */
export class JournalWeekDeletedDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  groupId!: string;

  @ApiProperty({ example: 3 })
  weekNumber!: number;
}
