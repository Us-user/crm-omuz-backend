import { Controller, Get, HttpStatus, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AccountType } from '@prisma/client';

import { AccountTypeGuard, RequireAccountType } from '../auth';
import { ApiDataResponse, ApiStandardErrors } from '../common';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { DashboardService } from './dashboard.service';
import {
  DashboardAttendanceDto,
  DashboardGraduatesDto,
  DashboardIncomeDto,
  DashboardIncomeQueryDto,
  DashboardLeadsDto,
  DashboardLeftCoursesDto,
  DashboardPeriodQueryDto,
  DashboardSummaryDto,
  DashboardSummaryQueryDto,
} from './dto';

/**
 * Дашборд (ТЗ 5.2) — сводная витрина центра.
 *
 * Шесть маршрутов ТЗ 5.2, все закрыты `Permission.Dashboard.Views` —
 * единственный код раздела в каталоге (сессия 0005), до сих пор никем
 * не требовавшийся. Прав на изменение здесь нет и быть не может: дашборд
 * только читает, а меняют данные те разделы, из которых он их берёт.
 *
 * **Денежная витрина требует второго права — `Permission.Accounting.Views`.**
 * Раздел Accounting входит в `DIRECTOR_ONLY_SECTIONS` (0006), то есть его права
 * не выдаются никому, кроме позиции Director (ТЗ 3.2: «Accounting виден только
 * позиции Director»). Без второго кода право «видеть сводную витрину» стало бы
 * обходом этого правила: доход, расходы и зарплата центра — те же числа,
 * что в `/accounting/overview`, и показывать их по более слабому праву значило
 * бы отменить ограничение, не сказав об этом. Тот же приём, что с позициями
 * в карточке сотрудника (0020), где право на карточку не должно было
 * становиться правом раздать себе `Director`.
 *
 * Это админ-сторона. У студента свой кабинет (`/me`, 0017), у ментора свой
 * (`/mentor/*`, 0023); ветвить дашборд по типу вызывающего значило бы повторить
 * ошибку, от которой уходила сессия 0017 — забытая ветка открывает чужие данные.
 */
@ApiTags('Dashboard')
@ApiBearerAuth('access-token')
@Controller('dashboard')
@RequireAccountType(AccountType.EMPLOYEE)
@UseGuards(AccountTypeGuard)
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('summary')
  @RequirePermission('Permission.Dashboard.Views')
  @ApiOperation({
    summary: 'Сводка центра',
    description:
      'Посещаемость за день и счётчики активных студентов, менторов и групп (ТЗ 5.2). ' +
      'Посещаемость относится к выбранной дате (по умолчанию — сегодня, UTC), ' +
      'а счётчики — к настоящему моменту: система не хранит истории статусов, ' +
      'и «активных групп на 3 августа» ей взять неоткуда. Ментор здесь — сотрудник, ' +
      'назначенный ментором живой группы, а не обладатель позиции с таким названием ' +
      '(позиция переименовывается, решение сессии 0010).',
  })
  @ApiDataResponse(DashboardSummaryDto, { description: 'Сводка на дату' })
  @ApiStandardErrors(HttpStatus.BAD_REQUEST, HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  summary(@Query() query: DashboardSummaryQueryDto): Promise<DashboardSummaryDto> {
    return this.dashboard.summary(query);
  }

  @Get('attendance')
  @RequirePermission('Permission.Dashboard.Views')
  @ApiOperation({
    summary: 'График посещаемости',
    description:
      'Present / Late / Absent по месяцам (ТЗ 5.2). Опоздание считается приходом ' +
      '(ТЗ 5.8) — в долю `attendanceRate` оно входит наравне с приходом, а отдельным ' +
      'числом остаётся ради графика. Неотмеченные клетки в счёт не идут: «не отмечен» ' +
      'и «отсутствовал» — разные состояния (решение сессии 0018). Без параметров ' +
      'показывается последний год, считая текущий месяц; месяцы без занятий остаются ' +
      'в ряду нулями. Период длиннее 60 месяцев отклоняется (400).',
  })
  @ApiDataResponse(DashboardAttendanceDto, { description: 'Посещаемость за период' })
  @ApiStandardErrors(HttpStatus.BAD_REQUEST, HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  attendance(@Query() query: DashboardPeriodQueryDto): Promise<DashboardAttendanceDto> {
    return this.dashboard.attendance(query);
  }

  @Get('leads-stats')
  @RequirePermission('Permission.Dashboard.Views')
  @ApiOperation({
    summary: 'Статистика лидов',
    description:
      'Воронка обращений (ТЗ 5.2): сколько пришло, сколько дошло до пробного дня ' +
      '(Client) и сколько стало студентами. Строка месяца — **когорта**: `clients` ' +
      'и `converted` считаются среди обращений этого месяца, а не среди перешедших ' +
      'в нём, иначе «отдача рекламы сентября» смешалась бы с ноябрьскими переходами. ' +
      'Разрез идёт по UTM-метке, а не по свободному полю «referral source»: свободный ' +
      'текст дал бы столько «категорий», сколько было операторов (решение сессии 0027).',
  })
  @ApiDataResponse(DashboardLeadsDto, { description: 'Воронка за период' })
  @ApiStandardErrors(HttpStatus.BAD_REQUEST, HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  leads(@Query() query: DashboardPeriodQueryDto): Promise<DashboardLeadsDto> {
    return this.dashboard.leads(query);
  }

  @Get('income')
  @RequirePermission('Permission.Dashboard.Views', 'Permission.Accounting.Views')
  @ApiOperation({
    summary: 'Доход за месяц со сравнением',
    description:
      'Касса центра за календарный месяц рядом с предыдущим (ТЗ 5.2): приход, расход, ' +
      'зарплата и итог `Income − Expense − Salary`. Приход считается **по дню платежа** ' +
      'и включает предоплаты — это касса, а не выставленные счета: неоплаченный месяц ' +
      'сюда не попадает (различие плана и кассы, решение сессии 0030). Числа совпадают ' +
      'с `GET /accounting/overview` за тот же месяц. ' +
      '**Требует двух прав:** `Permission.Dashboard.Views` и `Permission.Accounting.Views` — ' +
      'раздел Accounting доступен только позиции Director (ТЗ 3.2), и право на дашборд ' +
      'не должно быть обходом этого правила.',
  })
  @ApiDataResponse(DashboardIncomeDto, { description: 'Деньги месяца со сравнением' })
  @ApiStandardErrors(HttpStatus.BAD_REQUEST, HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  income(@Query() query: DashboardIncomeQueryDto): Promise<DashboardIncomeDto> {
    return this.dashboard.income(query);
  }

  @Get('graduates')
  @RequirePermission('Permission.Dashboard.Views')
  @ApiOperation({
    summary: 'Выпускники и трудоустройство',
    description:
      'Блок «Employed graduates» (ТЗ 5.2): счётчики трудоустройства по периоду выпуска ' +
      'и помесячный ряд выпусков. Трудоустроенными считаются `WORK`, `FREELANCER` ' +
      'и `ENTREPRENEUR`; продолжившие учёбу — нет. Доля считается среди тех, **чей ' +
      'статус выяснен**: невыясненный статус не означает «без работы» (решение ' +
      'сессии 0026). Счётчики сводятся той же функцией, что и `meta.employment` ' +
      'у `GET /graduates`.',
  })
  @ApiDataResponse(DashboardGraduatesDto, { description: 'Выпуски и трудоустройство за период' })
  @ApiStandardErrors(HttpStatus.BAD_REQUEST, HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  graduates(@Query() query: DashboardPeriodQueryDto): Promise<DashboardGraduatesDto> {
    return this.dashboard.graduates(query);
  }

  @Get('left-courses')
  @RequirePermission('Permission.Dashboard.Views')
  @ApiOperation({
    summary: 'Отток с курсов',
    description:
      'Блок «Left courses» (ТЗ 5.2): сколько человек покинуло курсы за период, ' +
      'помесячный ряд и разрез по курсам. Переведённые в другую группу сюда ' +
      'не попадают — перевод не является уходом (решение сессии 0012). Считается ' +
      'той же функцией, что и `GET /left-courses/stats`; разрезы по группам ' +
      'и филиалам остаются там.',
  })
  @ApiDataResponse(DashboardLeftCoursesDto, { description: 'Отток за период' })
  @ApiStandardErrors(HttpStatus.BAD_REQUEST, HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  leftCourses(@Query() query: DashboardPeriodQueryDto): Promise<DashboardLeftCoursesDto> {
    return this.dashboard.leftCourses(query);
  }
}
