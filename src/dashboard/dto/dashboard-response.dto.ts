import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Ответы дашборда (ТЗ 5.2).
 *
 * Каждая витрина отдаётся своим маршрутом — как их и перечисляет ТЗ 5.2.
 * Один сводный ответ выглядел бы дешевле для фронта, но у блоков **разная
 * природа периода**: у сводки это день, у дохода — календарный месяц, у графиков
 * — отрезок месяцев, а у выпускников период выпуска. Один период на всех был бы
 * тихо неверен хотя бы для одного блока, а второй источник тех же чисел рядом
 * с шестью маршрутами пришлось бы держать в согласии руками (девять раз тот же
 * разбор: 0012, 0019, 0025, 0026, 0029–0033).
 */

/** Именованная ссылка витрины: курс, группа или филиал. */
export class DashboardRefDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Frontend' })
  name!: string;
}

/** Разобранный период витрины: обе границы включительно. */
export class DashboardPeriodDto {
  @ApiProperty({ example: '2025-09' })
  from!: string;

  @ApiProperty({ example: '2026-08' })
  to!: string;

  @ApiProperty({ example: 12, description: 'Сколько месяцев в периоде — длина ряда.' })
  months!: number;
}

/** Столбец помесячного ряда со счётчиком — общая форма выпусков и уходов. */
export class DashboardMonthCountDto {
  @ApiProperty({ example: '2026-08' })
  month!: string;

  @ApiProperty({ example: 3 })
  count!: number;
}

// ──────────────────────────── GET /dashboard/summary ──────────────────────────

/** Посещаемость за один день (ТЗ 5.2). */
export class DashboardDayAttendanceDto {
  @ApiProperty({ example: 6, description: 'Сколько учебных дней журнала заведено на эту дату.' })
  lessons!: number;

  @ApiProperty({ example: 78 })
  present!: number;

  @ApiProperty({ example: 5 })
  late!: number;

  @ApiProperty({ example: 9 })
  absent!: number;

  @ApiProperty({ example: 92, description: 'Сколько клеток вообще отмечено.' })
  marked!: number;

  @ApiPropertyOptional({
    nullable: true,
    example: 90.22,
    description:
      'Доля приходов в процентах: опоздание считается приходом (ТЗ 5.8, то же правило ' +
      'и то же округление, что в витрине успеваемости). `null` — за день ничего ' +
      'не отмечено.',
  })
  attendanceRate!: number | null;
}

/** Счётчики студентов по статусам (ТЗ 5.3). */
export class DashboardStudentCountsDto {
  @ApiProperty({ example: 128, description: 'Учатся — «активные студенты» из ТЗ 5.2.' })
  active!: number;

  @ApiProperty({ example: 14, description: 'Покинули курс, не завершив его.' })
  noActive!: number;

  @ApiProperty({ example: 63 })
  finished!: number;

  @ApiProperty({ example: 2, description: 'Вход заблокирован (ТЗ 5.3), профиль остаётся.' })
  blocked!: number;

  @ApiProperty({ example: 207, description: 'Все профили центра.' })
  total!: number;
}

/** Счётчики групп по статусам (ТЗ 5.5). */
export class DashboardGroupCountsDto {
  @ApiProperty({ example: 4, description: 'Идёт набор.' })
  recruiting!: number;

  @ApiProperty({ example: 11, description: 'Занятия идут — «активные группы» из ТЗ 5.2.' })
  active!: number;

  @ApiProperty({ example: 26 })
  finished!: number;

  @ApiProperty({ example: 1, description: 'Набор не состоялся, обучения не было.' })
  cancelled!: number;

  @ApiProperty({ example: 42 })
  total!: number;
}

/** Счётчик менторов (ТЗ 5.2). */
export class DashboardMentorCountsDto {
  @ApiProperty({
    example: 9,
    description:
      'Действующие сотрудники, назначенные менторами хотя бы одной живой группы ' +
      '(набор или занятия). Ментор определён **менторством**, а не названием позиции: ' +
      'позиция переименовывается администратором, и счётчик, построенный на её ' +
      'названии, однажды молча стал бы нулём (решение сессии 0010).',
  })
  active!: number;
}

/** Сводка дашборда (ТЗ 5.2). */
export class DashboardSummaryDto {
  @ApiProperty({ example: '2026-08-03', description: 'День, за который взята посещаемость.' })
  date!: string;

  @ApiProperty({ type: DashboardDayAttendanceDto })
  attendance!: DashboardDayAttendanceDto;

  @ApiProperty({ type: DashboardStudentCountsDto })
  students!: DashboardStudentCountsDto;

  @ApiProperty({ type: DashboardMentorCountsDto })
  mentors!: DashboardMentorCountsDto;

  @ApiProperty({ type: DashboardGroupCountsDto })
  groups!: DashboardGroupCountsDto;
}

// ─────────────────────────── GET /dashboard/attendance ────────────────────────

/** Счётчики посещаемости за отрезок (ТЗ 5.2: «график Attendance (Late/Absent)»). */
export class DashboardAttendanceTotalsDto {
  @ApiProperty({ example: 1520 })
  present!: number;

  @ApiProperty({ example: 96 })
  late!: number;

  @ApiProperty({ example: 184 })
  absent!: number;

  @ApiProperty({ example: 1800 })
  marked!: number;

  @ApiPropertyOptional({ nullable: true, example: 89.78 })
  attendanceRate!: number | null;
}

/** Столбец графика посещаемости. */
export class DashboardMonthAttendanceDto extends DashboardAttendanceTotalsDto {
  @ApiProperty({ example: '2026-08' })
  month!: string;
}

/** График посещаемости за период (ТЗ 5.2). */
export class DashboardAttendanceDto {
  @ApiProperty({ type: DashboardPeriodDto })
  period!: DashboardPeriodDto;

  @ApiProperty({
    type: DashboardAttendanceTotalsDto,
    description:
      'Итог по всему периоду. Считается **той же** функцией, что и каждый столбец, ' +
      'а не сложением их долей: месяцы разной длины, и среднее из процентов ' +
      'не является процентом.',
  })
  totals!: DashboardAttendanceTotalsDto;

  @ApiProperty({
    type: [DashboardMonthAttendanceDto],
    description: 'Месяцы подряд, включая месяцы без занятий: ряд задаёт ось графика.',
  })
  byMonth!: DashboardMonthAttendanceDto[];
}

// ─────────────────────────── GET /dashboard/leads-stats ───────────────────────

/** Итоги воронки за период (ТЗ 5.2: «статистика лидов»). */
export class DashboardLeadTotalsDto {
  @ApiProperty({ example: 240, description: 'Все обращения периода.' })
  total!: number;

  @ApiProperty({ example: 150, description: 'Остались на стадии Lead.' })
  leads!: number;

  @ApiProperty({ example: 90, description: 'Побывали на пробном дне (Client, ТЗ 5.7).' })
  clients!: number;

  @ApiProperty({ example: 51, description: 'Переведены в студенты.' })
  converted!: number;

  @ApiPropertyOptional({ nullable: true, example: 37.5, description: 'Доля клиентов, %.' })
  clientRate!: number | null;

  @ApiPropertyOptional({
    nullable: true,
    example: 21.25,
    description: 'Доля дошедших до зачисления, %. `null` — обращений в периоде не было.',
  })
  conversionRate!: number | null;
}

/** Столбец воронки: **когорта месяца**, а не переходы, случившиеся в нём. */
export class DashboardMonthLeadsDto {
  @ApiProperty({ example: '2026-08' })
  month!: string;

  @ApiProperty({ example: 24, description: 'Обращений в этом месяце.' })
  total!: number;

  @ApiProperty({ example: 9, description: 'Из них дошли до пробного дня.' })
  clients!: number;

  @ApiProperty({ example: 5, description: 'Из них стали студентами.' })
  converted!: number;
}

/** Разрез по рекламной метке. */
export class DashboardLeadSourceDto {
  @ApiPropertyOptional({
    nullable: true,
    example: 'instagram',
    description: '`utm_source` рекламной ссылки. `null` — обращение пришло не по рекламе.',
  })
  source!: string | null;

  @ApiProperty({ example: 64 })
  count!: number;
}

/** Разрез по интересующему курсу. */
export class DashboardLeadCourseDto {
  @ApiPropertyOptional({
    type: DashboardRefDto,
    nullable: true,
    description: '`null` — курс в обращении не указан (поле необязательно, ТЗ 5.7).',
  })
  course!: DashboardRefDto | null;

  @ApiProperty({ example: 38 })
  count!: number;
}

/** Воронка обращений за период (ТЗ 5.2). */
export class DashboardLeadsDto {
  @ApiProperty({ type: DashboardPeriodDto })
  period!: DashboardPeriodDto;

  @ApiProperty({ type: DashboardLeadTotalsDto })
  totals!: DashboardLeadTotalsDto;

  @ApiProperty({ type: [DashboardMonthLeadsDto] })
  byMonth!: DashboardMonthLeadsDto[];

  @ApiProperty({
    type: [DashboardLeadSourceDto],
    description:
      'Разрез по **UTM-метке**, а не по свободному полю «referral source»: метка ' +
      'приходит из рекламной ссылки уже разобранной, а свободный текст дал бы столько ' +
      '«категорий», сколько было операторов (решение сессии 0027). По свободному ' +
      'источнику ищут в `GET /leads?search=`.',
  })
  byUtmSource!: DashboardLeadSourceDto[];

  @ApiProperty({ type: [DashboardLeadCourseDto] })
  byCourse!: DashboardLeadCourseDto[];
}

// ──────────────────────────── GET /dashboard/income ───────────────────────────

/** Число месяца рядом с числом предыдущего месяца. */
export class DashboardMoneyChangeDto {
  @ApiProperty({ example: 128400.5, description: 'Сумма выбранного месяца, сомони.' })
  current!: number;

  @ApiProperty({ example: 112300, description: 'Сумма предыдущего календарного месяца.' })
  previous!: number;

  @ApiProperty({ example: 16100.5, description: '`current − previous`; может быть отрицательным.' })
  change!: number;

  @ApiPropertyOptional({
    nullable: true,
    example: 14.34,
    description:
      'Рост в процентах. `null`, если в предыдущем месяце было ноль: «выросло ' +
      'в бесконечность раз» не число, и подставлять вместо него 0 или 100 значило бы ' +
      'выдумать величину.',
  })
  changePercent!: number | null;
}

/** Доход за месяц со сравнением (ТЗ 5.2). */
export class DashboardIncomeDto {
  @ApiProperty({ example: '2026-08' })
  month!: string;

  @ApiProperty({ example: '2026-07', description: 'Месяц, с которым идёт сравнение.' })
  previousMonth!: string;

  @ApiProperty({
    type: DashboardMoneyChangeDto,
    description:
      'Принятые деньги вместе с предоплатами — **касса**, а не выставленные счета ' +
      '(различие плана и кассы, решение сессии 0030). Неоплаченный месяц сюда ' +
      'не попадает, а предоплата — попадает.',
  })
  income!: DashboardMoneyChangeDto;

  @ApiProperty({
    type: DashboardMoneyChangeDto,
    description: 'Расходы центра **без зарплаты**: она стоит своим числом (решение 0032).',
  })
  expense!: DashboardMoneyChangeDto;

  @ApiProperty({
    type: DashboardMoneyChangeDto,
    description: 'Выплаченная зарплата, по дню выплаты.',
  })
  salary!: DashboardMoneyChangeDto;

  @ApiProperty({
    type: DashboardMoneyChangeDto,
    description: '`Income − Expense − Salary` — тем же правилом, что в обзоре бухгалтерии.',
  })
  net!: DashboardMoneyChangeDto;
}

// ────────────────────────── GET /dashboard/graduates ──────────────────────────

/** Счётчики трудоустройства (ТЗ 5.11) — те же, что в `meta.employment` у `/graduates`. */
export class DashboardEmploymentCountsDto {
  @ApiProperty({ example: 12 })
  OPEN_TO_WORK!: number;

  @ApiProperty({ example: 31 })
  WORK!: number;

  @ApiProperty({ example: 7 })
  FREELANCER!: number;

  @ApiProperty({ example: 4 })
  FURTHER_EDUCATION!: number;

  @ApiProperty({ example: 2 })
  ENTREPRENEUR!: number;

  @ApiProperty({
    example: 9,
    description:
      'Статус не выясняли. Отдельно от «ищет работу»: «не спрашивали» и «без работы» — ' +
      'разные вещи (решение сессии 0026).',
  })
  unknown!: number;
}

/** Блок «Employed graduates» (ТЗ 5.2). */
export class DashboardGraduatesDto {
  @ApiProperty({ type: DashboardPeriodDto })
  period!: DashboardPeriodDto;

  @ApiProperty({ example: 65, description: 'Выпусков за период.' })
  total!: number;

  @ApiProperty({ type: DashboardEmploymentCountsDto })
  employment!: DashboardEmploymentCountsDto;

  @ApiProperty({
    example: 40,
    description: 'Работают, фрилансят или ведут своё дело. Продолжившие учёбу сюда не входят.',
  })
  employed!: number;

  @ApiPropertyOptional({
    nullable: true,
    example: 71.43,
    description:
      'Доля трудоустроенных среди тех, **чей статус выяснен** (`total − unknown`), %. ' +
      'Невыясненный статус не означает «без работы», и включать его в знаменатель ' +
      'значило бы записать в безработные всех, до кого не дозвонились. `null` — статус ' +
      'не выяснен ни у кого.',
  })
  employmentRate!: number | null;

  @ApiProperty({
    type: [DashboardMonthCountDto],
    description: 'Выпуски по месяцам; месяцы без выпусков остаются в ряду с нулём.',
  })
  byMonth!: DashboardMonthCountDto[];
}

// ───────────────────────── GET /dashboard/left-courses ────────────────────────

/** Разрез оттока по курсам. */
export class DashboardCourseCountDto {
  @ApiProperty({ type: DashboardRefDto })
  ref!: DashboardRefDto;

  @ApiProperty({ example: 5 })
  count!: number;
}

/** Блок «Left courses» (ТЗ 5.2). */
export class DashboardLeftCoursesDto {
  @ApiProperty({ type: DashboardPeriodDto })
  period!: DashboardPeriodDto;

  @ApiProperty({ example: 17, description: 'Уходов с курсов за период.' })
  total!: number;

  @ApiProperty({
    type: [DashboardMonthCountDto],
    description: 'Месяцы подряд, включая месяцы без уходов: ряд задаёт ось графика.',
  })
  byMonth!: DashboardMonthCountDto[];

  @ApiProperty({
    type: [DashboardCourseCountDto],
    description:
      'Где отток сильнее. Разрезы по группам и филиалам остаются детальному экрану ' +
      '(`GET /left-courses/stats`): дашборд отвечает «сколько и куда смотреть», ' +
      'а не «кто именно». Считается **той же** функцией, что и детальный экран.',
  })
  byCourse!: DashboardCourseCountDto[];
}
