import { Controller, Get, HttpStatus, Param, ParseUUIDPipe, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { AccountType } from '@prisma/client';

import { AccountTypeGuard, RequireAccountType } from '../auth';
import { ApiDataResponse, ApiStandardErrors } from '../common';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { StudentPerformanceDto } from './dto';
import { PerformanceService } from './performance.service';

/**
 * Успеваемость студента (ТЗ 5.3: «Performance» на карточке студента).
 *
 * Закрыто `Permission.Students.Views`, а не отдельным правом: это раздел
 * карточки студента, и видеть его должны те же, кто видит саму карточку.
 * Своей успеваемости студент здесь не видит — для него будет `/me`
 * (кабинет, ТЗ 5.3), где данные выводятся из токена, а не из адреса.
 */
@ApiTags('Students')
@ApiBearerAuth('access-token')
@Controller('students/:studentId/performance')
@RequireAccountType(AccountType.EMPLOYEE)
@UseGuards(AccountTypeGuard)
export class PerformanceController {
  constructor(private readonly performance: PerformanceService) {}

  @Get()
  @RequirePermission('Permission.Students.Views')
  @ApiOperation({
    summary: 'Успеваемость студента',
    description:
      'Общий балл (ТЗ 5.8: среднее `Sum` по неделям), категория активности (ТЗ 5.5), ' +
      'место в рейтинге и корона (ТЗ 5.13), посещаемость, разрез по группам и закрытые ' +
      'недели для графика. **В общий балл входят только финализированные недели**: ' +
      'открытая неделя заводится с нулевыми итогами на весь состав, и учёт таких недель ' +
      'обрушивал бы балл каждый понедельник. В рейтинг идут только студенты ' +
      'с действующим членством — у выпускника балл есть, а места нет.',
  })
  @ApiParam({ name: 'studentId', format: 'uuid' })
  @ApiDataResponse(StudentPerformanceDto, { description: 'Успеваемость студента' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  findOne(@Param('studentId', ParseUUIDPipe) studentId: string): Promise<StudentPerformanceDto> {
    return this.performance.findStudentPerformance(studentId);
  }
}
