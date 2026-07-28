import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DirectoryStatus } from '@prisma/client';

/** Курс, на который действует купон. */
export class CouponCourseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Frontend-разработка' })
  title!: string;
}

/** Купон (ТЗ 5.7). */
export class CouponDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'OSEN-2026', description: 'Название или код купона.' })
  name!: string;

  @ApiPropertyOptional({ nullable: true, example: 'Осенняя акция для новых студентов' })
  description!: string | null;

  @ApiProperty({ example: 250.5, description: 'Сумма скидки в сомони (ТЗ 5.7).' })
  amount!: number;

  @ApiPropertyOptional({
    nullable: true,
    example: '2026-09-01',
    description: 'Начало периода действия, включительно. `null` — без начала.',
  })
  validFrom!: string | null;

  @ApiPropertyOptional({
    nullable: true,
    example: '2026-11-30',
    description: 'Конец периода действия, включительно. `null` — бессрочно.',
  })
  validTo!: string | null;

  @ApiProperty({
    enum: DirectoryStatus,
    description:
      'Active/Inactive из ТЗ 5.7. Отличается от периода: акцию можно выключить ' +
      'раньше срока, не переписывая её даты.',
  })
  status!: DirectoryStatus;

  @ApiProperty({
    type: [CouponCourseDto],
    description:
      'Курсы, на которые действует купон (ТЗ 5.7: «курс(ы)»). **Пустой список означает ' +
      '«на все курсы»** — купон без единого курса это скидка центра, а не сломанная запись.',
  })
  courses!: CouponCourseDto[];

  @ApiProperty({
    example: true,
    description:
      'Действует ли купон **сегодня**: `status = ACTIVE` и текущая дата внутри периода. ' +
      'Отдельной колонкой не хранится — это сравнение дат, и вторая копия того же факта ' +
      'разошлась бы с ними в первый же день.',
  })
  isCurrentlyValid!: boolean;

  @ApiProperty({
    example: 3,
    description: 'Скольким лидам купон уже обещан (ТЗ 5.7). Такой купон не удаляется.',
  })
  leadsCount!: number;

  @ApiProperty({ example: '2026-08-15T10:00:00.000Z' })
  createdAt!: string;
}

/** Ответ на удаление купона. */
export class CouponDeletedDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'OSEN-2026' })
  name!: string;
}
