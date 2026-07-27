import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ParentRelation } from '@prisma/client';

/** Родитель или опекун студента (ТЗ 4: Parent/Guardian). */
export class StudentParentDto {
  @ApiProperty({ format: 'uuid', description: 'Идентификатор записи родителя.' })
  id!: string;

  @ApiPropertyOptional({
    nullable: true,
    example: 'Гулнора',
    description: '`null` — запись заведена регистрацией (ТЗ 3.1), где известен только номер.',
  })
  firstName!: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'Каримова' })
  lastName!: string | null;

  @ApiProperty({ example: '+992907654321', description: 'Телефон в E.164 — ключ записи.' })
  phone!: string;

  @ApiPropertyOptional({ nullable: true, example: 'gulnora@mail.tj' })
  email!: string | null;

  @ApiPropertyOptional({ nullable: true, example: '@gulnora' })
  telegram!: string | null;

  @ApiPropertyOptional({ nullable: true })
  notes!: string | null;

  @ApiPropertyOptional({
    enum: ParentRelation,
    nullable: true,
    description: 'Кем приходится **этому** студенту: степень родства живёт на связке.',
  })
  relation!: ParentRelation | null;

  @ApiProperty({
    example: 2,
    description:
      'Сколько детей этого родителя учится в центре. Больше единицы — значит, правка ' +
      'записи видна и в других карточках: она общая.',
  })
  childrenCount!: number;

  @ApiProperty({
    example: '2026-07-29T09:30:00.000Z',
    description: 'Когда родитель привязан к этому студенту.',
  })
  linkedAt!: string;
}

/** Ответ на добавление: важно, завели новую запись или привязали существующую. */
export class StudentParentLinkedDto extends StudentParentDto {
  @ApiProperty({
    example: false,
    description:
      '`false` — родитель с таким телефоном уже был в системе и просто привязан ' +
      'к студенту (у него есть другие дети в центре).',
  })
  created!: boolean;
}

/** Ответ на отвязку — чтобы интерфейс мог сказать, что именно убрал. */
export class StudentParentUnlinkedDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: '+992907654321' })
  phone!: string;

  @ApiPropertyOptional({ nullable: true, example: 'Каримова Гулнора' })
  fullName!: string | null;

  @ApiProperty({
    example: true,
    description:
      'Была ли удалена сама запись родителя: без детей в центре она недостижима — ' +
      'отдельного справочника родителей нет.',
  })
  parentDeleted!: boolean;
}
